import { runProcess } from '../../shared/child-process/run-process'
import {
  readAgentProcess,
  type AgentProcessObservation
} from '../../shared/agent-process-presence-probe'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'

export type AgentIdentityBootstrapDeps = {
  platform: NodeJS.Platform
  readCanonical: (pid: number) => Promise<AgentProcessObservation>
  /** macOS: the start marker in the whole-table capture's own (unpinned) format. */
  readCaptureFormatStartTime: (pid: number) => Promise<string | null>
}

async function readCaptureFormatStartTime(pid: number): Promise<string | null> {
  // Why the inherited env: the fenced capture ran `ps` with it, so equal strings mean one process.
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-p', String(pid), '-o', 'lstart='],
    timeoutMs: 1000,
    maxOutputBytes: 1024
  })
  const value = result.stdout.trim()
  return !result.timedOut && result.code === 0 && value ? value : null
}

const DEFAULT_DEPS: AgentIdentityBootstrapDeps = {
  platform: process.platform,
  readCanonical: readAgentProcess,
  readCaptureFormatStartTime
}

/**
 * Converts the agent PID/start a fenced foreground capture recognized into the canonical identity
 * the targeted probe compares (Linux `boot-id:ticks`, macOS UTC `lstart`), only when the canonical
 * read provably names the same process. Any mismatch or unreadable step installs nothing.
 */
export async function bootstrapAgentProcessIdentity(
  captured: { pid: number; startTime: string },
  deps: AgentIdentityBootstrapDeps = DEFAULT_DEPS
): Promise<AgentProcessIdentity | null> {
  if (deps.platform === 'linux') {
    const canonical = await deps.readCanonical(captured.pid).catch(() => null)
    if (canonical?.verdict !== 'live' || canonical.zombie) {
      return null
    }
    // Why: the capture holds raw /proc start ticks; the canonical form prefixes the boot id.
    const ticks = canonical.startTime.slice(canonical.startTime.lastIndexOf(':') + 1)
    return ticks === captured.startTime.trim()
      ? { pid: captured.pid, platform: 'linux', startTime: canonical.startTime }
      : null
  }
  if (deps.platform === 'darwin') {
    const before = await deps.readCaptureFormatStartTime(captured.pid).catch(() => null)
    if (before !== captured.startTime.trim()) {
      return null
    }
    const canonical = await deps.readCanonical(captured.pid).catch(() => null)
    // Why read again: a reused PID between the two reads would carry a different start marker.
    const after = await deps.readCaptureFormatStartTime(captured.pid).catch(() => null)
    if (canonical?.verdict !== 'live' || canonical.zombie || after !== before) {
      return null
    }
    return { pid: captured.pid, platform: 'darwin', startTime: canonical.startTime }
  }
  // Why: no measured native Windows creation-time association yet; never fabricate one.
  return null
}
