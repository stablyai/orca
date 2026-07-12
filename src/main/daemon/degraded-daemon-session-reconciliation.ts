import type { DaemonPtyAdapter } from './daemon-pty-adapter'

export async function reconcileDegradedDaemonSessions(
  adapters: readonly DaemonPtyAdapter[],
  validWorktreeIds: Set<string>,
  onAlive: (id: string, adapter: DaemonPtyAdapter) => void,
  onKilled: (id: string) => void
): Promise<{ alive: string[]; killed: string[] }> {
  const alive: string[] = []
  const killed: string[] = []
  for (const adapter of adapters) {
    const result = await adapter.reconcileOnStartup(validWorktreeIds)
    for (const id of result.alive) {
      alive.push(id)
      onAlive(id, adapter)
    }
    for (const id of result.killed) {
      killed.push(id)
      onKilled(id)
    }
  }
  return { alive, killed }
}
