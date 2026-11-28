import { RuntimeEnvironmentStoreError } from '../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import type { SshTargetOrcadClaims } from '../../ssh/targets/ssh-target-orcad-claims'

/** Releases a deploy's provisional SSH claim when the store refused its registration, which no retry can change. Any other failure keeps the claim so the deploy can resume. */
export async function releaseClaimIfStoreRefused(
  claims: Pick<SshTargetOrcadClaims, 'release' | 'flush'>,
  error: unknown,
  args: { targetId: string; environmentId: string; signal?: AbortSignal }
): Promise<void> {
  if (error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument') {
    claims.release(args.targetId, args.environmentId)
    await claims.flush(args.signal)
  }
}
