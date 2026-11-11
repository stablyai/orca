import type { PtySpawnOperationState } from './spawn-operation-state'
import { restoreProvisionalPtySize } from './spawn-options-assembly'

export function normalizePtySpawnSessionId(sessionId: string | undefined): string | undefined {
  return typeof sessionId === 'string' ? sessionId.trim() || undefined : undefined
}

export function retirePreparation(
  adapter: { state: PtySpawnOperationState; releasePreparation?: () => void },
  reattachId?: string
): void {
  const ctx = adapter.state
  adapter.releasePreparation?.()
  restoreProvisionalPtySize(ctx, { reattachId })
  ctx.finishTerminalInstall()
  ctx.finishTerminalInstall = () => {}
  ctx.releaseWorktreeSpawn?.()
  ctx.releaseWorktreeSpawn = undefined
}
