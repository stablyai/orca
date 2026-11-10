import type { TerminalHost } from '../terminal-host/terminal-host'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'

export function listDaemonSessions(
  { host, preparations }: { host: TerminalHost; preparations: DaemonPtySpawnPreparations },
  includeReservations: boolean
) {
  return {
    sessions: host.listSessions(),
    ...(includeReservations
      ? { reservations: host.listReservations(preparations.reservedSessionIds()) }
      : {})
  }
}
