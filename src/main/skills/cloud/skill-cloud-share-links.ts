import type {
  SkillCloudCanonicalShare,
  SkillCloudOwnedShare,
  SkillCloudShare,
  SkillCloudShareTarget,
  SkillCloudVersion
} from '../../../shared/skill-cloud-contract'
import { skillCloudPathId, skillCloudRequest } from './skill-cloud-request'

const CANONICAL_SHARE_CAPABILITIES = ['share_canonical', 'share_repoint']

type Auth = { apiUrl: string; authToken: string; signal?: AbortSignal }

export async function requestSkillShareTarget(
  input: Auth & { packageId: string }
): Promise<SkillCloudShareTarget> {
  const result = await skillCloudRequest<{
    shares: SkillCloudOwnedShare[]
    capabilities?: string[]
  }>({
    apiUrl: input.apiUrl,
    authToken: input.authToken,
    path: '/v1/skill-shares',
    signal: input.signal
  })
  if (
    !CANONICAL_SHARE_CAPABILITIES.every((capability) => result.capabilities?.includes(capability))
  ) {
    return { kind: 'legacy' }
  }
  const share = result.shares.find(
    (candidate) => candidate.packageId === input.packageId && candidate.canonical
  )
  return share?.pinnedVersionId
    ? {
        kind: 'update',
        share: { id: share.id, url: share.url, pinnedVersionId: share.pinnedVersionId }
      }
    : { kind: 'canonical' }
}

/** Creates the package's canonical link, or moves the known one compare-and-set. */
export async function requestCanonicalSkillShare(
  input: Auth & {
    version: Pick<SkillCloudVersion, 'packageId' | 'versionId'>
    target: Exclude<SkillCloudShareTarget, { kind: 'legacy' }>
    idempotencyKey: string
  }
): Promise<SkillCloudShare> {
  const { target, version } = input
  const shared = await skillCloudRequest<{ share: SkillCloudCanonicalShare }>({
    apiUrl: input.apiUrl,
    authToken: input.authToken,
    ...(target.kind === 'update'
      ? {
          path: `/v1/skill-shares/${skillCloudPathId(target.share.id)}`,
          method: 'PATCH' as const,
          body: {
            pinnedVersionId: version.versionId,
            expectedVersionId: target.share.pinnedVersionId
          }
        }
      : {
          path: `/v1/skill-packages/${skillCloudPathId(version.packageId)}/shares`,
          method: 'POST' as const,
          body: { mode: 'canonical', pinnedVersionId: version.versionId }
        }),
    idempotencyKey: input.idempotencyKey,
    signal: input.signal
  })
  return { id: shared.share.id, url: shared.share.url }
}
