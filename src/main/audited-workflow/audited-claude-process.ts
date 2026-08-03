// Owns the spawned Claude process for an audited run: launch, capture, timeout,
// cancel, and tree-kill. The ONLY file in Phase 4 that imports child_process.
//
// Why not reuse generateCommitMessageFromContext: that entry point is hard-scoped
// to short text generation — a 60s timeout, a cancellation lane keyed by cwd
// (one run per cwd), a text-only return contract, and no quit-teardown
// registration. An audited run is long-lived and must not survive app quit, so
// this module reuses its BUILDING BLOCKS and adds the missing wiring.
import { spawn, type ChildProcess } from 'node:child_process'
import { resolveCliCommand } from '../codex-cli/command'
import { killWithDescendantSweep } from '../pty-descendant-termination'
import { getSpawnArgsForWindows, UnsafeWindowsBatchArgumentsError } from '../win32-utils'
import { MAX_EXECUTION_OUTPUT_BYTES } from './audited-execution-output-store'

export const EXECUTION_TIMEOUT_MS = 30 * 60 * 1000

export type ClaudeProcessOutcome =
  | { kind: 'exit'; exitCode: number | null; stdout: string; stderr: string }
  | { kind: 'not_found' }
  | { kind: 'spawn_failed' }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | { kind: 'output_too_large'; stdout: string; stderr: string }

export type RunClaudeArgs = {
  argv: string[]
  cwd: string
  /** Delivered on stdin — never argv, so it stays out of any process listing. */
  prompt: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

// Live runs by runId, so cancel and quit-teardown can reach a process that was
// started by a different call stack.
const liveProcesses = new Map<string, ChildProcess>()

export function hasLiveProcess(runId: string): boolean {
  return liveProcesses.has(runId)
}

/**
 * Kills a run's process tree. Resolves even when nothing is live, so cancel and
 * teardown never fail on an already-exited run.
 */
export async function killClaudeProcess(runId: string): Promise<void> {
  const child = liveProcesses.get(runId)
  if (!child) {
    return
  }
  const pid = child.pid
  if (typeof pid !== 'number') {
    child.kill('SIGKILL')
    return
  }
  await killWithDescendantSweep(pid, () => {
    child.kill('SIGKILL')
  })
}

/** Kills every live run. Registered as a NamedQuitTeardown so no child survives quit. */
export async function killAllClaudeProcesses(): Promise<void> {
  await Promise.all([...liveProcesses.keys()].map((runId) => killClaudeProcess(runId)))
}

export function createQuitTeardown(): { name: string; promise: Promise<unknown> } {
  return { name: 'auditedExecution', promise: killAllClaudeProcesses() }
}

/**
 * Spawns Claude and captures bounded output.
 *
 * Never rejects: every failure mode is a closed outcome, because a rejection
 * here would leave the run's `running` row unfinalized.
 */
export async function runClaudeProcess(
  runId: string,
  args: RunClaudeArgs
): Promise<ClaudeProcessOutcome> {
  let command: string
  try {
    command = resolveCliCommand('claude', {})
  } catch {
    return { kind: 'not_found' }
  }

  let spawnCmd: string
  let spawnArgs: string[]
  try {
    const prepared = getSpawnArgsForWindows(command, args.argv)
    spawnCmd = prepared.spawnCmd
    spawnArgs = prepared.spawnArgs
  } catch (error) {
    if (error instanceof UnsafeWindowsBatchArgumentsError) {
      return { kind: 'spawn_failed' }
    }
    throw error
  }

  return new Promise<ClaudeProcessOutcome>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(spawnCmd, spawnArgs, {
        cwd: args.cwd,
        env: args.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      resolve({ kind: 'spawn_failed' })
      return
    }

    liveProcesses.set(runId, child)

    let stdout = ''
    let stderr = ''
    let settled = false
    let cancelled = false
    let overflowed = false

    const finish = (outcome: ClaudeProcessOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      liveProcesses.delete(runId)
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      cancelled = true
      void killClaudeProcess(runId).finally(() => {
        finish({ kind: 'timeout', stdout, stderr })
      })
    }, args.timeoutMs ?? EXECUTION_TIMEOUT_MS)
    timer.unref?.()

    // The live cap: a runaway agent is killed rather than allowed to fill memory
    // or disk. Checked on every chunk, not at exit.
    const checkOverflow = (): void => {
      if (overflowed || stdout.length + stderr.length <= MAX_EXECUTION_OUTPUT_BYTES) {
        return
      }
      overflowed = true
      void killClaudeProcess(runId).finally(() => {
        finish({ kind: 'output_too_large', stdout, stderr })
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      checkOverflow()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      checkOverflow()
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ kind: error.code === 'ENOENT' ? 'not_found' : 'spawn_failed' })
    })

    child.on('close', (code) => {
      if (overflowed) {
        finish({ kind: 'output_too_large', stdout, stderr })
        return
      }
      if (cancelled) {
        finish({ kind: 'timeout', stdout, stderr })
        return
      }
      if (cancelRequests.has(runId)) {
        cancelRequests.delete(runId)
        finish({ kind: 'cancelled', stdout, stderr })
        return
      }
      finish({ kind: 'exit', exitCode: code, stdout, stderr })
    })

    // Prompt on stdin, never argv — avoids Windows argv limits and keeps the
    // prompt out of any process listing.
    try {
      child.stdin?.write(args.prompt)
      child.stdin?.end()
    } catch {
      // A closed stdin means the process already died; `close` handles it.
    }
  })
}

// Runs a human explicitly cancelled, so `close` can distinguish a cancel from a
// plain non-zero exit.
const cancelRequests = new Set<string>()

export function markCancelRequested(runId: string): void {
  cancelRequests.add(runId)
}

export function clearCancelRequest(runId: string): void {
  cancelRequests.delete(runId)
}

/** Test seam: lets a suite assert no process leaked between cases. */
export function resetClaudeProcessStateForTests(): void {
  liveProcesses.clear()
  cancelRequests.clear()
}
