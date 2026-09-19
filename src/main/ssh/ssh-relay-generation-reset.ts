import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'

/** True when this connect landed on a different relay bundle than the last successful one. */
export function isSshRelayGenerationChange(
  previousBuildId: string | undefined,
  nextBuildId: string | undefined
): boolean {
  return Boolean(previousBuildId && nextBuildId && previousBuildId !== nextBuildId)
}

/** Drop leases so the new generation cannot reattach or cold-restore the unreachable PTYs. */
export function retireSshRelayGenerationLeases(
  store: { markSshRemotePtyLeases: (targetId: string, state: 'expired') => void },
  targetId: string
): void {
  store.markSshRemotePtyLeases(targetId, 'expired')
}

export function shouldBroadcastSshRelayGenerationRetired(targetId: string): boolean {
  return !isRuntimeOwnedSshTargetId(targetId)
}
