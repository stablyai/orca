import { ipcMain, type WebContents } from 'electron'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
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
  CrossMachineRecoveryBridgeErrorCode,
  CrossMachineRecoveryInspectArgs,
  CrossMachineRecoveryListArgs,
  CrossMachineRecoveryPickupArgs,
  CrossMachineRecoveryPickupProgressEvent,
  CrossMachineRecoveryProviderResult,
  WithClientInstanceId
} from '../../shared/cross-machine-recovery-provider-ipc'

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
  code: CrossMachineRecoveryBridgeErrorCode,
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

export function createCrossMachineRecoveryProvider(getProviderPath: () => string) {
  const pickups = new Map<string, { child: ChildProcessWithoutNullStreams; cancelled: boolean }>()

  async function query<T>(
    argv: string[],
    clientInstanceId: string,
    parse: Parser<T>
  ): Promise<CrossMachineRecoveryProviderResult<T>> {
    try {
      const result = await runProcess({
        program: getProviderPath(),
        args: [...argv, '--json'],
        env: buildProviderEnv(process.env, clientInstanceId),
        timeoutMs: QUERY_TIMEOUT_MS,
        maxOutputBytes: MAX_PROVIDER_OUTPUT_BYTES
      })
      return interpretQuery(result, parse)
    } catch (error) {
      return spawnFailure(error)
    }
  }

  function pickup(
    sender: Pick<WebContents, 'send' | 'isDestroyed'>,
    args: WithClientInstanceId<CrossMachineRecoveryPickupArgs>
  ): Promise<CrossMachineRecoveryProviderResult<CcSyncPickup>> {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess({
        program: getProviderPath(),
        args: [...pickupArgv(args), '--json'],
        env: buildProviderEnv(process.env, args.clientInstanceId),
        detached: true
      })
    } catch (error) {
      return Promise.resolve(spawnFailure(error))
    }
    const entry = { child, cancelled: false }
    pickups.set(args.operationId, entry)
    const stdout = createOutputSink(MAX_PROVIDER_OUTPUT_BYTES)
    const stderr = createOutputSink(MAX_PROVIDER_OUTPUT_BYTES)
    let pendingLine = ''
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
      lines.forEach(forwardProgress)
    })
    return new Promise((resolve) => {
      child.once('error', (error) => {
        pickups.delete(args.operationId)
        resolve(spawnFailure(error))
      })
      child.once('close', (code) => {
        pickups.delete(args.operationId)
        forwardProgress(pendingLine)
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
            ? { ok: false, error: { code: 'cancelled', message: 'Recovery was cancelled.' } }
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
    await signalProcessTree(entry.child, 'SIGTERM')
  }

  return {
    status: (clientInstanceId: string) => query(['status'], clientInstanceId, parseCcSyncStatus),
    list: (args: WithClientInstanceId<CrossMachineRecoveryListArgs>) =>
      query(listArgv(args), args.clientInstanceId, parseCcSyncList),
    inspect: (args: WithClientInstanceId<CrossMachineRecoveryInspectArgs>) =>
      query(
        ['inspect', args.selector, ...(args.checkpoint ? ['--checkpoint', args.checkpoint] : [])],
        args.clientInstanceId,
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
    () => store.getSettings().crossMachineRecovery?.providerPath?.trim() || DEFAULT_PROVIDER_PATH
  )
  ipcMain.handle('crossMachineRecovery:status', (_event, args: { clientInstanceId: string }) =>
    provider.status(args.clientInstanceId)
  )
  ipcMain.handle(
    'crossMachineRecovery:list',
    (_event, args: WithClientInstanceId<CrossMachineRecoveryListArgs>) => provider.list(args)
  )
  ipcMain.handle(
    'crossMachineRecovery:inspect',
    (_event, args: WithClientInstanceId<CrossMachineRecoveryInspectArgs>) => provider.inspect(args)
  )
  ipcMain.handle(
    'crossMachineRecovery:pickup',
    (event, args: WithClientInstanceId<CrossMachineRecoveryPickupArgs>) =>
      provider.pickup(event.sender, args)
  )
  ipcMain.handle('crossMachineRecovery:cancel', (_event, args: { operationId: string }) =>
    provider.cancel(args.operationId)
  )
}
