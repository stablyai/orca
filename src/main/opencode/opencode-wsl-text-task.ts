import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { OPENCODE_WSL_TEXT_TASK_FILENAME } from '../../shared/remote-bundle-artifacts'
import { SearchSubprocessLineAccumulator } from '../../shared/search-subprocess-lines'
import { relayBundleCandidates } from '../ssh/relay-bundle-paths'
import { ensureWslPinnedRuntime } from '../wsl/execution/wsl-pinned-runtime'
import { runWslProcess, type WslSpec } from '../wsl/execution/wsl-runner'
import { describeWslProcessFailure } from '../wsl/execution/wsl-process-failure'
import { translateArgsForWsl } from '../git/command-runner/wsl-path-translation'
import { spawnSourceControlAgent } from '../text-generation/source-control-agent-launch'
import { killSourceControlAgentProcess } from '../text-generation/source-control-agent-termination'
import { MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES } from '../text-generation/source-control-generation-limits'
import { waitForProcessExitUntil } from '../provider-process/provider-process-exit-deadline'
import type {
  TextGenerationOperation,
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from '../text-generation/source-control-text-generation-types'
import { OpenCodeTextTaskError } from './opencode-owned-text-task'
import {
  OPENCODE_WSL_TEXT_TASK_CLEANUP_MS,
  openCodeWslTextTaskResult,
  type OpenCodeWslTextTaskResult
} from './opencode-wsl-text-task-protocol'

export type OpenCodeWslTextTask = {
  distro: string
  /** The generation target's directory; the guest login shell enters it as existing launches do. */
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Command assignments; the guest applies them after its login rc, as existing launches do. */
  commandEnv?: Record<string, string>
  binary: string
  prefixArgs: readonly string[]
  prompt: string
  runArgs: readonly string[]
  legacyVariantFlag?: boolean
  operation?: TextGenerationOperation
  signal: AbortSignal
  /** Checked here before the guest starts; the guest cannot call back. */
  shouldExecute?: () => boolean
  /** Guest-side deadline backstop for when this process cannot cancel it. */
  timeoutMs: number
}

export type OpenCodeWslGuestRuntime = { node: string; helper: string }

export type OpenCodeWslTextTaskDeps = {
  prepare?: (distro: string) => Promise<OpenCodeWslGuestRuntime>
  spawnAgent?: SpawnSourceControlAgent
  stop?: (child: SpawnedSourceControlAgentProcess) => Promise<void>
}

const PREPARATION_TIMEOUT_MS = 180_000
const PREPARED_TTL_MS = 10 * 60_000
const prepared = new Map<string, { runtime: Promise<OpenCodeWslGuestRuntime>; expires: number }>()
// Only the APIs the bundled task uses; the scanner's SQLite requirement does not apply here.
const GUEST_NODE_PROBE =
  "if(typeof Promise.withResolvers!=='function'||typeof AbortSignal.any!=='function'||typeof AbortSignal.timeout!=='function'||typeof fetch!=='function'||typeof ReadableStream!=='function')process.exit(3);process.stdout.write(process.execPath)"

async function prepareGuestRuntime(distro: string): Promise<OpenCodeWslGuestRuntime> {
  const helper = relayBundleCandidates('wsl')
    .map((directory) => join(directory, OPENCODE_WSL_TEXT_TASK_FILENAME))
    .find(existsSync)
  if (!helper) {
    throw new Error('The bundled WSL OpenCode text task is missing. Reinstall Orca to repair it.')
  }
  const run = async (spec: WslSpec, timeoutMs = 15_000): Promise<string> => {
    const result = await runWslProcess({ ...spec, distro, timeoutMs, maxOutputBytes: 16 * 1024 })
    if (result.code !== 0 || result.timedOut) {
      throw new Error(`WSL ${distro}: ${describeWslProcessFailure(result)}`)
    }
    return result.stdout.trim()
  }
  let node: string | null = null
  try {
    node = await run({ program: 'node', args: ['-e', GUEST_NODE_PROBE], loginPath: 'preferred' })
  } catch {
    // Missing or too old: provision the pinned runtime instead.
  }
  if (!node?.startsWith('/')) {
    node = await ensureWslPinnedRuntime(
      run,
      join(getAppEnvironment().getPath('userData'), 'orcad-artifacts'),
      AbortSignal.timeout(PREPARATION_TIMEOUT_MS)
    )
  }
  return {
    node,
    helper: await run({ program: 'wslpath', args: ['-a', '-u', helper], loginPath: 'none' })
  }
}

/** Shared per distro and bounded on its own, so one cancelled task cannot abort another's install. */
function preparedGuestRuntime(distro: string): Promise<OpenCodeWslGuestRuntime> {
  const key = distro.toLowerCase()
  const entry = prepared.get(key)
  if (entry && entry.expires > Date.now()) {
    return entry.runtime
  }
  const runtime = prepareGuestRuntime(distro)
  prepared.set(key, { runtime, expires: Date.now() + PREPARED_TTL_MS })
  runtime.catch(() => {
    if (prepared.get(key)?.runtime === runtime) {
      prepared.delete(key)
    }
  })
  return runtime
}

/** Waits within the task's own deadline; the shared install keeps its separate bound. */
async function prepareOpenCodeWslTextTask(
  distro: string,
  signal: AbortSignal,
  deps: OpenCodeWslTextTaskDeps = {}
): Promise<OpenCodeWslGuestRuntime> {
  try {
    return await waitForPromiseWithSignal((deps.prepare ?? preparedGuestRuntime)(distro), signal)
  } catch (error) {
    if (signal.aborted) {
      throw signal.reason
    }
    throw new OpenCodeTextTaskError('startup', { cause: error })
  }
}

export async function runOpenCodeWslTextTask(
  input: OpenCodeWslTextTask,
  deps: OpenCodeWslTextTaskDeps = {}
): Promise<string> {
  const startedAt = Date.now()
  const { signal } = input
  const runtime = await prepareOpenCodeWslTextTask(input.distro, signal, deps)
  signal.throwIfAborted()
  if (input.shouldExecute?.() === false) {
    throw new OpenCodeTextTaskError('superseded')
  }
  const nonce = randomBytes(16).toString('hex')
  let child: SpawnedSourceControlAgentProcess
  try {
    child = (deps.spawnAgent ?? spawnSourceControlAgent)({
      // The helper Node starts without the user's startup options; OpenCode's login shell restores them.
      binary: '/usr/bin/env',
      args: ['-u', 'NODE_OPTIONS', runtime.node, runtime.helper],
      cwd: input.cwd,
      env: input.env,
      wslDistro: input.distro,
      stdinMode: 'pipe',
      useCwdForNative: true
    })
  } catch (error) {
    throw new OpenCodeTextTaskError('startup', { cause: error })
  }
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  let result: OpenCodeWslTextTaskResult | undefined
  // Login-shell rc output shares stdout; only the nonce-prefixed line is the guest's result.
  const lines = new SearchSubprocessLineAccumulator(
    MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES,
    'discard'
  )
  child.stdout?.on('data', (chunk: Buffer) => {
    if (result) {
      return
    }
    lines.push(chunk, (line) => {
      const frame = line.trimEnd()
      if (!result && frame.startsWith(nonce)) {
        try {
          result = openCodeWslTextTaskResult.parse(JSON.parse(frame.slice(nonce.length)))
        } catch {
          // A malformed frame is no result; the exit below reports the failure.
        }
      }
    })
  })
  child.stderr?.on('data', () => {})
  child.once('error', () => {})
  child.stdin?.on('error', () => {})
  // Ending stdin is the guest's cancel; it then stops its server before exiting.
  const cancel = (): void => {
    child.stdin?.end()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    child.stdin?.write(
      `${JSON.stringify({
        nonce,
        binary: input.binary,
        prefixArgs: translateArgsForWsl([...input.prefixArgs]),
        prompt: input.prompt,
        // Existing WSL launches translate Windows paths in every argument, e.g. `--file C:\x`.
        runArgs: translateArgsForWsl([...input.runArgs]),
        legacyVariantFlag: input.legacyVariantFlag,
        operation: input.operation,
        commandEnv: input.commandEnv,
        timeoutMs: Math.max(1, input.timeoutMs - (Date.now() - startedAt))
      })}\n`
    )
    if (signal.aborted) {
      cancel()
    }
    // Wait for the guest's own exit; force-stop the launcher only past the guest's cleanup bound.
    const bound = startedAt + input.timeoutMs + OPENCODE_WSL_TEXT_TASK_CLEANUP_MS - Date.now()
    await waitForProcessExitUntil(exited, Math.max(0, bound))
    if (child.exitCode === null && child.signalCode === null) {
      await (deps.stop ?? killSourceControlAgentProcess)(child)
      await exited
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    child.stdin?.end()
  }
  if (result?.ok) {
    return result.text
  }
  if (signal.aborted) {
    throw signal.reason
  }
  if (!result) {
    // The guest never answered; its prepared runtime may be gone.
    prepared.delete(input.distro.toLowerCase())
  }
  throw new OpenCodeTextTaskError(result && result.stage !== 'aborted' ? result.stage : 'startup')
}
