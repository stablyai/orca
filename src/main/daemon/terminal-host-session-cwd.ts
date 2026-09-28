import { resolveProcessCwd } from '../providers/process-cwd'
import type { Session } from './session'

export async function resolveTerminalHostSessionCwd(session: Session): Promise<string | null> {
  const tracked = session.getCwd()
  if (tracked) {
    return tracked
  }
  const shellPid = session.shellProcessId
  if (!shellPid) {
    return null
  }
  const resolved = await resolveProcessCwd(shellPid)
  return resolved || null
}
