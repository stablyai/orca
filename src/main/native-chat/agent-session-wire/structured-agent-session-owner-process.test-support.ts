import { expect, vi } from 'vitest'
import type { AgentSessionProcessIdentity } from '../../../shared/agent-session-record'
import * as processRows from '../../provider-process/provider-process-row-read'
import * as processIdentity from '../../runtime/agent-session-process-identity-probe'
import * as descendants from '../../pty-descendant-termination'

/** A recorded fake incarnation, never a real host process-table or descendant operation. */
export function mockRecordedOwnerProcess(
  owner: AgentSessionProcessIdentity | null | undefined
): void {
  if (!owner || owner.processStartTimeMs == null) {
    throw new Error('recovery fixture has no recorded process incarnation')
  }
  const started = owner.processStartTimeMs
  vi.spyOn(processRows, 'readPosixProcessRow').mockImplementation(async (pid) => {
    expect(pid).toBe(owner.pid)
    return {
      pid,
      ppid: 1,
      pgid: pid,
      startedAt: 'fixture-incarnation',
      startResolution: 'clock-tick'
    }
  })
  vi.spyOn(processIdentity, 'readProcessStartTimeMs').mockImplementation(async (pid) => {
    expect(pid).toBe(owner.pid)
    return started
  })
  vi.spyOn(descendants, 'captureDescendantSnapshot').mockResolvedValue(null)
}
