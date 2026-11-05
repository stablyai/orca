import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { OpenCodeCliCapabilities } from '../../shared/opencode-cli-version'
import { probeOpenCodeCliVersion, type OpenCodeCliVersionProbe } from './opencode-cli-version'
import { runOpenCodeTextTaskSession } from './opencode-text-task-session'
import { prepareOpenCodeTextTaskInput } from './opencode-text-task-input'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from '../text-generation/source-control-generation-limits'
import { waitForProcessExitUntil } from '../provider-process/provider-process-exit-deadline'
import type {
  SpawnedSourceControlAgentProcess,
  SourceControlAgentSpawnInput
} from '../text-generation/source-control-text-generation-types'

export type OpenCodeTextTaskSpawnContext = {
  privateEnv?: Readonly<Record<string, string>>
  captureVersion?: true
}

/** Kept free of Electron/main-only imports: the WSL guest entry bundles this same task. */
export type OwnedOpenCodeTextTask = {
  binary: string
  prefixArgs: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  prompt: string
  /** The recipe's `run` options; resolved against the probed release on this host's filesystem. */
  runArgs: readonly string[]
  legacyVariantFlag?: boolean
  signal: AbortSignal
  spawn: (
    input: SourceControlAgentSpawnInput,
    context?: OpenCodeTextTaskSpawnContext
  ) => SpawnedSourceControlAgentProcess
  readVersionStdout?: (stdout: string) => string | null
  /** Force-stops a child that did not exit after its stdin closed. */
  stop: (child: SpawnedSourceControlAgentProcess) => Promise<void>
  probeVersion?: (probe: OpenCodeCliVersionProbe) => Promise<OpenCodeCliCapabilities>
  /** False before semantic input means the request is stale; nothing is prompted. */
  shouldExecute?: () => boolean
}

/** `startup`: no session was prompted. `session`: the model ran and failed. `superseded`: shouldExecute refused. */
export type OpenCodeTextTaskStage = 'startup' | 'session' | 'superseded'

export class OpenCodeTextTaskError extends Error {
  constructor(
    readonly stage: OpenCodeTextTaskStage,
    options?: { cause?: unknown }
  ) {
    super(`OpenCode text task failed during ${stage}`, options)
    this.name = 'OpenCodeTextTaskError'
  }
}

const VERSION_PROBE_TIMEOUT_MS = 5_000
const VERSION_OUTPUT_MAX_BYTES = 4_096
const STDIN_CLOSE_GRACE_MS = 1_500
const lease = z.object({ url: z.url() })

function closed(child: SpawnedSourceControlAgentProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('close', () => resolve())
  })
}

async function closeOwned(
  child: SpawnedSourceControlAgentProcess,
  exited: Promise<void>,
  stop: OwnedOpenCodeTextTask['stop']
): Promise<void> {
  // v2's stdio lease ends with stdin; v1 serve and stuck children need the owner's stop.
  child.stdin?.end()
  await waitForProcessExitUntil(exited, STDIN_CLOSE_GRACE_MS)
  if (child.exitCode === null && child.signalCode === null) {
    await stop(child)
  }
  // Ownership lasts until the exact process and its supervised group settle.
  await exited
}

function spawnOwned(
  input: OwnedOpenCodeTextTask,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = input.cwd,
  context?: OpenCodeTextTaskSpawnContext
): { child: SpawnedSourceControlAgentProcess; exited: Promise<void> } {
  const child = input.spawn(
    {
      binary: input.binary,
      args,
      cwd,
      env,
      stdinMode: 'pipe',
      useCwdForNative: true
    },
    context
  )
  return { child, exited: closed(child) }
}

/** Runs to its own bound rather than the task signal, so a cancel cannot cache an unknown version. */
function probeVersion(input: OwnedOpenCodeTextTask): Promise<OpenCodeCliCapabilities> {
  return (input.probeVersion ?? probeOpenCodeCliVersion)({
    executablePath: input.binary,
    // Prefixes select the CLI behind one launcher (e.g. `npx opencode` vs `npx opencode2`); the probe hashes this.
    hostIdentity: JSON.stringify([process.platform, input.prefixArgs]),
    cwd: input.cwd,
    env: input.env,
    execute: async () => {
      const { child, exited } = spawnOwned(
        input,
        [...input.prefixArgs, '--version'],
        input.env,
        input.cwd,
        { captureVersion: true }
      )
      const ready = Promise.withResolvers<number | null>()
      let stdout = ''
      let bytes = 0
      child.stdout?.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > VERSION_OUTPUT_MAX_BYTES) {
          ready.reject(new Error('Version output too large'))
        } else {
          stdout += chunk.toString('utf8')
        }
      })
      child.stderr?.on('data', () => {})
      child.once('error', (error) => ready.reject(error))
      child.once('close', (code) => ready.resolve(code))
      child.stdin?.end()
      try {
        const code = await waitForPromiseWithSignal(
          ready.promise,
          AbortSignal.timeout(VERSION_PROBE_TIMEOUT_MS)
        )
        return {
          code,
          stdout: input.readVersionStdout ? (input.readVersionStdout(stdout) ?? '') : stdout,
          timedOut: false
        }
      } catch {
        return { code: null, stdout, timedOut: true }
      } finally {
        await closeOwned(child, exited, input.stop)
      }
    }
  })
}

function readServerUrl(
  child: SpawnedSourceControlAgentProcess,
  v2: boolean,
  signal: AbortSignal
): Promise<string> {
  const ready = Promise.withResolvers<string>()
  let buffered = ''
  let bytes = 0
  let listening = false
  child.stdout?.on('data', (chunk: Buffer) => {
    if (listening) {
      return
    }
    bytes += chunk.byteLength
    if (bytes > MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES) {
      ready.reject(new Error('OpenCode server readiness exceeded its output limit'))
      return
    }
    buffered += chunk.toString('utf8')
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      let url: string | undefined
      if (v2) {
        try {
          url = lease.parse(JSON.parse(line)).url
        } catch {
          continue
        }
      } else {
        url = line.match(/listening on (http:\/\/\S+)/)?.[1]
      }
      if (!url) {
        continue
      }
      const address = new URL(url)
      if (
        address.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
      ) {
        ready.reject(new Error('OpenCode private server returned an unexpected address'))
        return
      }
      listening = true
      ready.resolve(address.origin)
    }
  })
  // Readiness output can contain credentials; never retain or log either stream.
  child.stderr?.on('data', () => {})
  child.once('error', (error) => ready.reject(error))
  child.once('close', () => ready.reject(new Error('OpenCode private server exited')))
  return waitForPromiseWithSignal(ready.promise, signal)
}

function splitModel(task: { model?: string; variant?: string }, v2: boolean) {
  let model = task.model
  let variant = task.variant
  // v2 recipes may carry the variant as `provider/model#variant`.
  if (v2 && model?.includes('#')) {
    const separator = model.lastIndexOf('#')
    variant ??= model.slice(separator + 1)
    model = model.slice(0, separator)
  }
  if (!model) {
    return { variant }
  }
  const separator = model.indexOf('/')
  if (separator <= 0) {
    throw new Error('OpenCode model must include its provider')
  }
  return {
    model: { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) },
    variant
  }
}

/**
 * One exclusive private server per task: probe the selected executable's protocol, start `serve`,
 * run the policy-bound session, then close and await the server on every outcome.
 */
export async function runOwnedOpenCodeTextTask(input: OwnedOpenCodeTextTask): Promise<string> {
  const { signal } = input
  const refuseStale = (): void => {
    if (input.shouldExecute?.() === false) {
      throw new OpenCodeTextTaskError('superseded')
    }
  }
  let owned: ReturnType<typeof spawnOwned> | undefined
  let began = false
  try {
    signal.throwIfAborted()
    refuseStale()
    const capabilities = await probeVersion(input)
    signal.throwIfAborted()
    refuseStale()
    if (capabilities.pluginApi === 'unknown') {
      throw new Error('OpenCode native protocol is unavailable')
    }
    const v2 = capabilities.pluginApi === 'v2'
    const version = v2 ? 'v2' : 'v1'
    const { directory, serverArgs, model, variant, ...run } = await prepareOpenCodeTextTaskInput({
      version,
      cwd: input.cwd,
      prompt: input.prompt,
      runArgs: input.runArgs,
      legacyVariantFlag: input.legacyVariantFlag,
      signal
    })
    const selection = splitModel({ model, variant }, v2)
    const password = randomBytes(32).toString('base64url')
    const privateEnv: Record<string, string> = v2
      ? { OPENCODE_PASSWORD: password }
      : { OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password }
    owned = spawnOwned(
      input,
      [
        ...input.prefixArgs,
        'serve',
        ...serverArgs,
        ...(v2 ? ['--stdio'] : ['--hostname', '127.0.0.1']),
        '--port',
        '0'
      ],
      { ...input.env, ...privateEnv },
      directory,
      { privateEnv }
    )
    const lost = new AbortController()
    owned.child.once('close', () => lost.abort(new Error('OpenCode private server exited')))
    const taskSignal = AbortSignal.any([signal, lost.signal])
    const url = await readServerUrl(owned.child, v2, taskSignal)
    refuseStale()
    began = true
    return await runOpenCodeTextTaskSession({
      ...run,
      ...selection,
      version,
      url,
      password,
      directory,
      signal: taskSignal
    })
  } catch (error) {
    if (error instanceof OpenCodeTextTaskError) {
      throw error
    }
    if (signal.aborted) {
      throw signal.reason
    }
    throw new OpenCodeTextTaskError(began ? 'session' : 'startup', { cause: error })
  } finally {
    if (owned) {
      await closeOwned(owned.child, owned.exited, input.stop)
    }
  }
}
