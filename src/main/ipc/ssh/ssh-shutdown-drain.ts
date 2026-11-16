import {
  connectInFlight,
  invalidateConnectAttempt,
  testConnectionProbes
} from './ssh-connect-attempt-registry'
import { connectionManager, portForwardManager } from './ssh-ipc-context'
import { shutdownOrcadManagedTunnels } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { closeAllPlainSshTerminals } from '../../ssh/plain-ssh-terminal/plain-ssh-terminal-sessions'

// One absolute deadline bounds all phases, including connects stuck before their next cancellation checkpoint.
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
    },
    {
      // Independent ssh -L children survive app exit and retain ports needed by the next launch.
      targetId: '*forwards',
      promise: Promise.all([portForwardManager?.closeAll(), shutdownOrcadManagedTunnels()])
    },
    {
      // Plain SSH terminals have no restoration owner and must end with Orca.
      targetId: '*plain-ssh',
      promise: closeAllPlainSshTerminals()
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
  // Joining connects can reveal transports opened after the first drain.
  if (await runPhase('in-flight-join', inFlight)) {
    await runPhase('final-drain', sshShutdownTasks())
  }

  if (errors.length > 0 || unfinished.length > 0) {
    // Aggregate quit-path logging to preserve time for the final flush.
    console.warn(
      `[ssh] Shutdown drain finished with ${errors.length} error(s); unfinished: ${
        unfinished.map((entry) => `${entry.targetId}/${entry.phase}`).join(', ') || 'none'
      }`
    )
  }
  return { unfinished, errors }
}

/** Snapshot-affecting transitions run synchronously before returning the shared drain promise.
 * Committed quit owns the fence; without it, this entry point only drains. */
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
