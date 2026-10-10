import type { StablePaneOwner } from './stable-owner'

export function stablePanePersistenceFence(
  owner: StablePaneOwner | null
): { ptyId: string; incarnationId?: string } | undefined {
  return owner?.hasPersistedBinding
    ? {
        ptyId: owner.ptyId,
        ...(owner.persistedIncarnationId ? { incarnationId: owner.persistedIncarnationId } : {})
      }
    : undefined
}
