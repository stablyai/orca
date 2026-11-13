import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mailWakeObligation } from '../../../../../shared/agent-session/lifecycle/mail-wake-obligation'
import type { TerminalProcessInspection } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

export type MailWakeRetryPorts = {
  current: () => SleepingAgentSessionRecord | null
  owns: (ptyId: string, incarnationId: string) => boolean
  commandEnded: (id: string, ptyId: string, incarnationId: string) => boolean
  occupied: (ptyId: string) => boolean
  drivingInputAt: (ptyId: string) => number | null
  inspect: (ptyId: string, incarnationId: string) => Promise<TerminalProcessInspection | undefined>
  shellInFront: (ptyId: string) => Promise<boolean>
}

/** Command return is only a hint; ownership, a complete child census and an untouched shell authorize retry. */
export async function admitsMailWakeRetry(
  record: SleepingAgentSessionRecord,
  ports: MailWakeRetryPorts
): Promise<boolean> {
  const marker = record.mailWake
  const attempt = marker?.attempt
  if (!marker || !attempt) {
    return false
  }
  const stillOwns = (): boolean => {
    const current = ports.current()
    return (
      mailWakeObligation(current) === 'retained' &&
      current?.mailWake?.id === marker.id &&
      current.mailWake.attempt?.launchToken === attempt.launchToken &&
      ports.owns(attempt.ptyId, attempt.incarnationId) &&
      ports.commandEnded(marker.id, attempt.ptyId, attempt.incarnationId) &&
      (ports.drivingInputAt(attempt.ptyId) ?? -1) < attempt.startedAt &&
      !ports.occupied(attempt.ptyId)
    )
  }
  if (!stillOwns()) {
    return false
  }
  const inspection = await ports.inspect(attempt.ptyId, attempt.incarnationId)
  const observation = inspection?.foregroundObservation
  if (
    inspection?.childProcessEvidence !== 'no-children' ||
    inspection.hasChildProcesses ||
    observation?.verdict !== 'observed' ||
    observation.ptyId !== attempt.ptyId ||
    observation.ptyIncarnationId !== attempt.incarnationId ||
    observation.foregroundKind !== 'shell'
  ) {
    return false
  }
  return (await ports.shellInFront(attempt.ptyId)) && stillOwns()
}
