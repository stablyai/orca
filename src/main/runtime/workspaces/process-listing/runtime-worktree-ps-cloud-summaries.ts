import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import { markCloudWorkspaceSummaries } from '../../../hosted-sandbox/cloud-workspace-ps-status'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'

/** `worktree.ps` summaries with Orca Cloud workspaces marked, so clients draw them as cloud. */
export function buildRuntimeWorktreePsSummariesWithCloud(
  args: Parameters<typeof buildRuntimeWorktreePsSummaries>[0]
): ReturnType<typeof buildRuntimeWorktreePsSummaries> {
  const summaries = buildRuntimeWorktreePsSummaries(args)
  markCloudWorkspaceSummaries(summaries.values(), getProfileUserDataPath())
  return summaries
}
