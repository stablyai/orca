import { z } from 'zod'
import type { CommunityGitHubSource } from './community-github-source'
import type { CommunitySourceDiff } from '../../shared/community-operations'
const comparison = z.object({
  files: z
    .array(z.object({ filename: z.string(), status: z.string(), patch: z.string().optional() }))
    .max(300)
})
export async function captureCommunitySourceDiff(
  source: Pick<CommunityGitHubSource, 'request'>,
  baseSha: string,
  headSha: string,
  expectedFiles: number,
  signal: AbortSignal
): Promise<CommunitySourceDiff> {
  const data = comparison.parse(await source.request(`compare/${baseSha}...${headSha}`, signal))
  let remaining = 180_000
  let complete = data.files.length === expectedFiles
  const files = data.files.map((file) => {
    const patch = file.patch?.slice(0, Math.min(32_000, remaining)) ?? null
    remaining -= patch?.length ?? 0
    if (!patch || patch.length !== file.patch?.length) {
      complete = false
    }
    return { path: file.filename, status: file.status, patch }
  })
  return { baseSha, headSha, files, complete }
}
