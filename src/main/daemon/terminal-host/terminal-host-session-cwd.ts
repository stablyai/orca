import { resolveProcessCwd } from '../../providers/working-directory/process-cwd'
import type { Session } from '../sessions/session'

export async function resolveTerminalHostSessionCwd(session: Session): Promise<string | null> {
  const tracked = session.getCwd()
  if (tracked) {
    return tracked
  }
  const resolved = await resolveProcessCwd(session.pid)
  return resolved || null
}
