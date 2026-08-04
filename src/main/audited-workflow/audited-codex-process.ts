// Owns the spawned Codex process for an audited plan review: launch, capture,
// timeout, cancel, and tree-kill.
//
// A SEPARATE module from audited-claude-process.ts, with its own live-process
// map, deliberately: cancelling a plan audit must never be able to reach a
// Claude execution run (and vice versa). Sharing one map would make a runId
// collision or a mis-keyed cancel kill the wrong agent.
import { spawn, type ChildProcess } from 'node:child_process'
import { resolveCliCommand } from '../codex-cli/command'
import { killWithDescendantSweep } from '../pty-descendant-termination'
import { getSpawnArgsForWindows, UnsafeWindowsBatchArgumentsError } from '../win32-utils'
import { MAX_EXECUTION_OUTPUT_BYTES } from './audited-execution-output-store'
import { CODEX_PLAN_AUDIT_TIMEOUT_MS, findLaunchPlanViolation } from './audited-codex-launch-plan'

export type CodexProcessOutcome =
  | { kind: 'exit'; exitCode: number | null; stdout: string; stderr: string }
  | { kind: 'not_found' }
  | { kind: 'spawn_failed' }
  | { kind: 'launch_plan_invalid' }
  | { kind: 'timeout'; stdout: string; stderr: string }
  | { kind: 'cancelled'; stdout: string; stderr: string }
  | { kind: 'output_too_large'; stdout: string; stderr: string }

export type RunCodexArgs = {
  argv: string[]
  cwd: string
  /** Delivered on stdin — never argv, so it stays out of any process listing. */
  prompt: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

const liveProcesses = new Map<string, ChildProcess>()
const cancelRequests = new Set<string>()

export function hasLiveCodexProcess(runId: string): boolean {
  return liveProcesses.has(runId)
}

/**
 * Kills a review's process tree. Resolves even when nothing is live, so cancel
 * and teardown never fail on an already-exited run.
 */
export async function killCodexProcess(runId: string): Promise<void> {
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

/** Kills every live review. Registered as a NamedQuitTeardown so none survives quit. */
export async function killAllCodexProcesses(): Promise<void> {
  await Promise.all([...liveProcesses.keys()].map((runId) => killCodexProcess(runId)))
}

export function createCodexQuitTeardown(): { name: string; promise: Promise<unknown> } {
  return { name: 'auditedPlanReview', promise: killAllCodexProcesses() }
}

export function markCodexCancelRequested(runId: string): void {
  cancelRequests.add(runId)
}

export function clearCodexCancelRequest(runId: string): void {
  cancelRequests.delete(runId)
}

/**
 * Spawns Codex and captures bounded output.
 *
 * Never rejects: every failure mode is a closed outcome, because a rejection
 * here would leave the review run's `running` row unfinalized.
 */
export async function runCodexProcess(
  runId: string,
  args: RunCodexArgs
): Promise<CodexProcessOutcome> {
  // Re-assert the safety contract immediately before spawning. The orchestration
  // already built this argv through buildCodexPlanAuditPlan, but this is the
  // last point at which a mutated array can still be stopped.
  if (findLaunchPlanViolation(args.argv) !== null) {
    return { kind: 'launch_plan_invalid' }
  }

  let command: string
  try {
    command = resolveCliCommand('codex', {})
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

  return new Promise<CodexProcessOutcome>((resolve) => {
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
    let timedOut = false
    let overflowed = false

    const finish = (outcome: CodexProcessOutcome): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      liveProcesses.delete(runId)
      resolve(outcome)
    }

    const timer = setTimeout(() => {
      timedOut = true
      void killCodexProcess(runId).finally(() => {
        finish({ kind: 'timeout', stdout, stderr })
      })
    }, args.timeoutMs ?? CODEX_PLAN_AUDIT_TIMEOUT_MS)
    timer.unref?.()

    // The live cap: a runaway reviewer is killed rather than allowed to fill
    // memory or disk. Checked on every chunk, not at exit.
    const checkOverflow = (): void => {
      if (overflowed || stdout.length + stderr.length <= MAX_EXECUTION_OUTPUT_BYTES) {
        return
      }
      overflowed = true
      void killCodexProcess(runId).finally(() => {
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
      if (timedOut) {
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

    try {
      child.stdin?.write(args.prompt)
      child.stdin?.end()
    } catch {
      // A closed stdin means the process already died; `close` handles it.
    }
  })
}

/** Test seam: lets a suite assert no process leaked between cases. */
export function resetCodexProcessStateForTests(): void {
  liveProcesses.clear()
  cancelRequests.clear()
}
