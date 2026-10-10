import { getLocalPtyProvider } from '../ipc/pty/provider/registry'

// The shell pid of a pty this Mac hosts, from the provider's session list (a daemon RPC, not a
// process-table scan). Ids of SSH or runtime ptys are not in it, so those resolve to 0.
export async function localPtyShellPid(ptyId: string): Promise<number> {
  const sessions = await getLocalPtyProvider()
    .listProcesses()
    .catch(() => [])
  return sessions.find((session) => session.id === ptyId)?.rootProcessId ?? 0
}
