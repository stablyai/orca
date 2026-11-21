import type * as pty from 'node-pty'
import { ForegroundAgentExitWatches } from '../../pty/process-retirement/foreground-agent-exit-watches'
import { foregroundJobLeaderPid } from '../../pty/process-retirement/pty-master-foreground-observation'
import type { PtyBackgroundStreamEvent } from '../pty/events'

const listeners = new Set<(event: PtyBackgroundStreamEvent) => void>()
const watches = new ForegroundAgentExitWatches((id) => {
  for (const listener of listeners) {
    listener({ id, kind: 'transientFact', fact: { kind: 'foreground-exit' } })
  }
})

/** In-process PTYs (no daemon) watch their foreground agent the same way the daemon does. */
export function noteLocalPtyInspection(
  id: string,
  isAlive: boolean,
  proc: pty.IPty,
  foreground: string | null
): boolean {
  return watches.noteInspection(
    id,
    {
      isAlive,
      // ConPTY has no foreground group, and this provider caches no agent pid.
      foregroundAgentPid: () => (process.platform === 'win32' ? null : foregroundJobLeaderPid(proc))
    },
    foreground
  )
}

export function forgetLocalPtyAgentExitWatch(id: string): void {
  watches.forget(id)
}

export function onLocalPtyAgentExit(
  callback: (event: PtyBackgroundStreamEvent) => void
): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}
