import type { CustomBuildInfo } from '../../shared/custom-build'
import type { CommunityPullRequest } from '../../shared/community-catalog'
import type { CommunityInstalledSnapshot } from '../../shared/community-installed-changes'
import type { CommunityService } from './community-service'

export async function readCommunityInstalled(
  build: CustomBuildInfo | null,
  source: Pick<CommunityService, 'captured' | 'detail'>
): Promise<CommunityInstalledSnapshot> {
  const numbers = [
    ...new Set(
      build?.changes.flatMap((change) => (change.pullRequest ? [change.pullRequest.number] : [])) ??
        []
    )
  ]
  const sources: CommunityPullRequest[] = []
  const unavailable: number[] = []
  for (let index = 0; index < numbers.length; index += 2) {
    await Promise.all(
      numbers.slice(index, index + 2).map(async (number) => {
        try {
          sources.push((await source.captured(number)) ?? (await source.detail(number)))
        } catch {
          unavailable.push(number)
        }
      })
    )
  }
  return { build, sources, unavailable }
}
