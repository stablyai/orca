import {
  connectInFlight,
  invalidateConnectAttempt,
  testConnectionProbes
} from './ssh-connect-attempt-registry'
import { connectionManager } from './ssh-ipc-context'

// Why one budget for the whole sequence rather than one per phase: an invalidated connect only
// observes its cancellation at the next checkpoint, and one blocked in the transport handshake can
// sit there for the whole SSH timeout. A per-phase timeout lets any single phase consume the global
// quit deadline; a shared absolute deadline cannot.
export const SSH_SHUTDOWN_BUDGET_MS = 6_000

export type SshShutdownPhase = 'drain' | 'in-flight-join' | 'final-drain'
export type SshShutdownUnfinished = { targetId: string; phase: SshShutdownPhase }
export type SshShutdownResult = {
  unfinished: readonly SshShutdownUnfinished[]
  errors: readonly unknown[]
}

type SshShutdownTask = { targetId: string; promise: Promise<unknown> }

let sshShutdownDrain: Promise<SshShutdownResult> | null = null

export function resetSshShutdownDrain(): void {
  sshShutdownDrain = null
}

async function settleTasksWithinMs(
  tasks: readonly SshShutdownTask[],
  timeoutMs: number
): Promise<{ timedOut: SshShutdownTask[]; errors: unknown[] }> {
  const pending = new Set(tasks)
  const errors: unknown[] = []
  if (tasks.length === 0) {
    return { timedOut: [], errors }
  }
  const tracked = tasks.map(async (task) => {
    try {
      await task.promise
    } catch (error) {
      errors.push(error)
    }
    pending.delete(task)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(tracked),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
    ])
  } finally {
    clearTimeout(timer)
  }
  return { timedOut: [...pending], errors }
}

function sshShutdownTasks(): SshShutdownTask[] {
  return [
    {
      targetId: '*transports',
      promise: connectionManager?.disconnectAll() ?? Promise.resolve()
    }
  ]
}

async function drainSshShutdown(inFlight: readonly SshShutdownTask[]): Promise<SshShutdownResult> {
  const deadline = Date.now() + SSH_SHUTDOWN_BUDGET_MS
  const unfinished: SshShutdownUnfinished[] = []
  const errors: unknown[] = []
  const runPhase = async (
    phase: SshShutdownPhase,
    tasks: readonly SshShutdownTask[]
  ): Promise<boolean> => {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      unfinished.push(...tasks.map((task) => ({ targetId: task.targetId, phase })))
      return false
    }
    const settled = await settleTasksWithinMs(tasks, remainingMs)
    errors.push(...settled.errors)
    unfinished.push(...settled.timedOut.map((task) => ({ targetId: task.targetId, phase })))
    return settled.timedOut.length === 0
  }

  await runPhase('drain', sshShutdownTasks())
  // Why a second drain after the join: a connect can open a transport before it reaches the
  // cancellation checkpoint, so the first drain can miss it.
  if (await runPhase('in-flight-join', inFlight)) {
    await runPhase('final-drain', sshShutdownTasks())
  }

  if (errors.length > 0 || unfinished.length > 0) {
    // Why one aggregate line: per-target logging on the quit path competes with the final flush for
    // the little time that remains.
    console.warn(
      `[ssh] Shutdown drain finished with ${errors.length} error(s); unfinished: ${
        unfinished.map((entry) => `${entry.targetId}/${entry.phase}`).join(', ') || 'none'
      }`
    )
  }
  return { unfinished, errors }
}

// Why one entry point that returns rather than awaits: every in-memory transition the final store
// flush must snapshot happens synchronously here, before this returns, so the caller can start that
// flush with no await in between. Idempotent — a later call joins the same drain and repeats no
// state transition.
//
// Why no fence latch here: the committed quit path sets it before calling this, so it is already on
// for the snapshot below. Called without that gate (tests), this degrades to a plain drain.
export function beginSshShutdown(): Promise<SshShutdownResult> {
  if (sshShutdownDrain) {
    return sshShutdownDrain
  }
  const inFlight: SshShutdownTask[] = [
    ...[...connectInFlight.entries()].map(([targetId, attempt]) => ({
      targetId,
      promise: attempt.promise
    })),
    ...[...testConnectionProbes].map((promise) => ({ targetId: '*probe', promise }))
  ]
  for (const targetId of Array.from(connectInFlight.keys())) {
    invalidateConnectAttempt(targetId)
  }
  sshShutdownDrain = drainSshShutdown(inFlight)
  return sshShutdownDrain
}
