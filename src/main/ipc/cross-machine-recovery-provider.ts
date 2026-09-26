import { ipcMain, type WebContents } from 'electron'
import type { Store } from '../persistence'
import {
  runProcess,
  spawnProcess,
  type ProcessResult
} from '../../shared/child-process/run-process'
import { createOutputSink } from '../../shared/child-process/bounded-output-sink'
import { signalProcessTree } from '../../shared/child-process/process-tree-termination'
import {
  parseCcSyncInspect,
  parseCcSyncList,
  parseCcSyncPickup,
  parseCcSyncProgressLine,
  parseCcSyncStatus,
  type CcSyncParseResult,
  type CcSyncPickup
} from '../../shared/cross-machine-recovery-provider-types'
import type {
  CrossMachineRecoveryInspectArgs,
  CrossMachineRecoveryListArgs,
  CrossMachineRecoveryPickupArgs,
  CrossMachineRecoveryPickupProgressEvent,
  CrossMachineRecoveryProviderError,
  CrossMachineRecoveryProviderResult
} from '../../shared/cross-machine-recovery-provider-ipc'
import { readOrMintCrossMachineRecoveryClientInstanceId } from '../runtime/cross-machine-recovery/client-instance-id'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

const DEFAULT_PROVIDER_PATH = 'cc-sync'
const QUERY_TIMEOUT_MS = 15_000
const MAX_PROVIDER_OUTPUT_BYTES = 4 * 1024 * 1024
// Why: the provider must reach the local Orca only, so remote-selection inputs never leak into it.
const SCRUBBED_ENV_KEYS = ['ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING'] as const
export const PICKUP_PROGRESS_CHANNEL = 'crossMachineRecovery:pickupProgress'

type Parser<T> = (raw: unknown) => CcSyncParseResult<T>

export function buildProviderEnv(
  base: NodeJS.ProcessEnv,
  clientInstanceId: string
): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of SCRUBBED_ENV_KEYS) {
    delete env[key]
  }
  env.CC_SYNC_ORCA_CLIENT_INSTANCE_ID = clientInstanceId
  return env
}

function fail<T>(
  code: CrossMachineRecoveryProviderError['code'],
  message: string
): CrossMachineRecoveryProviderResult<T> {
  return { ok: false, error: { code, message } }
}

function spawnFailure<T>(error: unknown): CrossMachineRecoveryProviderResult<T> {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return fail('not-installed', 'The recovery provider is not installed.')
  }
  return fail('provider-failed', error instanceof Error ? error.message : String(error))
}

function interpretOutput<T>(
  output: { code: number | null; stdout: string; stderr: string },
  parse: Parser<T>
): CrossMachineRecoveryProviderResult<T> {
  let raw: unknown
  try {
    raw = JSON.parse(output.stdout)
  } catch {
    const detail = output.stderr.trim().split('\n').at(-1) ?? ''
    return output.code === 0
      ? fail('invalid-output', 'The recovery provider printed no JSON.')
      : fail('provider-failed', detail || `The recovery provider exited with ${output.code}.`)
  }
  const parsed = parse(raw)
  if (parsed.kind === 'failure') {
    return { ok: false, error: parsed.error }
  }
  if (parsed.kind === 'invalid') {
    return fail('invalid-output', parsed.message)
  }
  return output.code === 0
    ? { ok: true, value: parsed.value }
    : fail('provider-failed', `The recovery provider exited with ${output.code}.`)
}

function interpretQuery<T>(
  result: ProcessResult,
  parse: Parser<T>
): CrossMachineRecoveryProviderResult<T> {
  if (result.timedOut) {
    return fail('timeout', 'The recovery provider did not answer in time.')
  }
  if (result.outputTruncated) {
    return fail('output-too-large', 'The recovery provider answer was too large.')
  }
  return interpretOutput(result, parse)
}

function listArgv(args: CrossMachineRecoveryListArgs): string[] {
  return [
    'list',
    ...(args.source ? ['--source', args.source] : []),
    ...(args.repo ? ['--repo', args.repo] : []),
    ...(args.all ? ['--all'] : [])
  ]
}

const MAX_PROGRESS_LINE_CHARS = 4096

type PickupChild = ReturnType<typeof spawnProcess>
type PickupOperation = { child: PickupChild | null; cancelled: boolean }

function pickupArgv(args: CrossMachineRecoveryPickupArgs): string[] {
  return [
    'pickup',
    args.selector,
    ...(args.checkpoint ? ['--checkpoint', args.checkpoint] : []),
    ...args.resume.flatMap((sessionId) => ['--resume', sessionId]),
    ...(args.onDivergence ? ['--on-divergence', args.onDivergence] : []),
    '--progress',
    'ndjson'
  ]
}

function cancelledResult<T>(): CrossMachineRecoveryProviderResult<T> {
  return fail('cancelled', 'Recovery was cancelled.')
}

export function createCrossMachineRecoveryProvider(
  getProviderPath: () => string,
  getClientInstanceId: () => Promise<string>
) {
  const pickups = new Map<string, PickupOperation>()

  async function query<T>(
    argv: string[],
    parse: Parser<T>
  ): Promise<CrossMachineRecoveryProviderResult<T>> {
    try {
      const result = await runProcess({
        program: getProviderPath(),
        args: [...argv, '--json'],
        env: buildProviderEnv(process.env, await getClientInstanceId()),
        timeoutMs: QUERY_TIMEOUT_MS,
        maxOutputBytes: MAX_PROVIDER_OUTPUT_BYTES
      })
      return interpretQuery(result, parse)
    } catch (error) {
      return spawnFailure(error)
    }
  }

  // Why: registered before the first await so a cancel sent right after pickup always finds it.
  async function pickup(
    sender: Pick<WebContents, 'send' | 'isDestroyed'>,
    args: CrossMachineRecoveryPickupArgs
  ): Promise<CrossMachineRecoveryProviderResult<CcSyncPickup>> {
    const entry: PickupOperation = { child: null, cancelled: false }
    pickups.set(args.operationId, entry)
    let child: PickupChild
    try {
      const clientInstanceId = await getClientInstanceId()
      if (entry.cancelled) {
        pickups.delete(args.operationId)
        return cancelledResult()
      }
      child = spawnProcess({
        program: getProviderPath(),
        args: [...pickupArgv(args), '--json'],
        env: buildProviderEnv(process.env, clientInstanceId),
        detached: true
      })
    } catch (error) {
      pickups.delete(args.operationId)
      return spawnFailure(error)
    }
    entry.child = child
    const stdout = createOutputSink(MAX_PROVIDER_OUTPUT_BYTES)
    const stderr = createOutputSink(MAX_PROVIDER_OUTPUT_BYTES)
    let pendingLine = ''
    let discardingLine = false
    const forwardProgress = (line: string): void => {
      const progress = parseCcSyncProgressLine(line)
      if (progress && !sender.isDestroyed()) {
        const event: CrossMachineRecoveryPickupProgressEvent = {
          operationId: args.operationId,
          progress
        }
        sender.send(PICKUP_PROGRESS_CHANNEL, event)
      }
    }
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', () => {})
    }
    child.stdin.end()
    child.stdout.on('data', (chunk: Buffer | string) => stdout.write(chunk))
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr.write(chunk)
      const lines = (pendingLine + chunk.toString()).split('\n')
      pendingLine = lines.pop() ?? ''
      if (discardingLine && lines.length > 0) {
        lines.shift()
        discardingLine = false
      }
      // Why: the unterminated tail lives outside the capped sink, so it needs its own bound.
      if (pendingLine.length > MAX_PROGRESS_LINE_CHARS) {
        pendingLine = ''
        discardingLine = true
      }
      lines.forEach(forwardProgress)
    })
    return new Promise((resolve) => {
      child.once('error', (error) => {
        pickups.delete(args.operationId)
        resolve(spawnFailure(error))
      })
      child.once('close', (code) => {
        pickups.delete(args.operationId)
        if (!discardingLine) {
          forwardProgress(pendingLine)
        }
        if (stdout.truncated()) {
          resolve(fail('output-too-large', 'The recovery provider answer was too large.'))
          return
        }
        const result = interpretOutput(
          { code, stdout: stdout.text(), stderr: stderr.text() },
          parseCcSyncPickup
        )
        resolve(
          entry.cancelled && !result.ok && result.error.code !== 'cancelled'
            ? cancelledResult()
            : result
        )
      })
    })
  }

  async function cancel(operationId: string): Promise<void> {
    const entry = pickups.get(operationId)
    if (!entry) {
      return
    }
    entry.cancelled = true
    if (entry.child) {
      await signalProcessTree(entry.child, 'SIGTERM')
    }
  }

  return {
    status: () => query(['status'], parseCcSyncStatus),
    list: (args: CrossMachineRecoveryListArgs) => query(listArgv(args), parseCcSyncList),
    inspect: (args: CrossMachineRecoveryInspectArgs) =>
      query(
        ['inspect', args.selector, ...(args.checkpoint ? ['--checkpoint', args.checkpoint] : [])],
        parseCcSyncInspect
      ),
    pickup,
    cancel
  }
}

export function registerCrossMachineRecoveryProviderHandlers(
  store: Pick<Store, 'getSettings'>
): void {
  const provider = createCrossMachineRecoveryProvider(
    () => store.getSettings().crossMachineRecovery?.providerPath?.trim() || DEFAULT_PROVIDER_PATH,
    () => readOrMintCrossMachineRecoveryClientInstanceId(getProfileUserDataPath())
  )
  ipcMain.handle('crossMachineRecovery:status', () => provider.status())
  ipcMain.handle('crossMachineRecovery:list', (_event, args: CrossMachineRecoveryListArgs) =>
    provider.list(args)
  )
  ipcMain.handle('crossMachineRecovery:inspect', (_event, args: CrossMachineRecoveryInspectArgs) =>
    provider.inspect(args)
  )
  ipcMain.handle('crossMachineRecovery:pickup', (event, args: CrossMachineRecoveryPickupArgs) =>
    provider.pickup(event.sender, args)
  )
  ipcMain.handle('crossMachineRecovery:cancel', (_event, args: { operationId: string }) =>
    provider.cancel(args.operationId)
  )
}
