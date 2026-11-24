import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getWorktreeIdFromHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { Repo } from '../../../shared/repository/repo-types'
import type { RuntimeWorktreePsSummary } from '../../../shared/worktree/catalog/runtime-worktree-contracts'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import type { PairedFolderChildren } from './workspace-cleanup-paired-folder-children'
import { folderSiblingsByWorktree, summaryIdentity } from './workspace-cleanup-folder-membership'

/** Above any real host's workspace count; a truncated listing is refused, not trusted. */
export const WORKTREE_PS_LIMIT = 100_000

/**
 * A sibling the best-effort listing still lacks may sit in a project whose listing failed. Consent
 * re-reads only those projects strictly, so a failure refuses the comparison instead of dropping the
 * member, while an unrelated broken project can't block a healthy group.
 */
async function listMissingSiblingProjectsStrictly(
  runtime: OrcaRuntimeService,
  listed: RuntimeWorktreePsSummary[],
  projectId: string,
  repos: ReadonlyMap<string, Repo>,
  folderSiblingsOf: (summary: RuntimeWorktreePsSummary) => string[]
): Promise<RuntimeWorktreePsSummary[]> {
  const identities = new Set(listed.map(summaryIdentity))
  const missing = new Set(
    listed
      .filter((summary) => summary.repoId === projectId)
      .flatMap(folderSiblingsOf)
      .filter((identity) => !identities.has(identity))
      .map((identity) => getRepoIdFromWorktreeId(getWorktreeIdFromHostIdentity(identity)))
      .filter((repoId) => repoId !== projectId && repos.has(repoId))
  )
  const reads = await Promise.all(
    [...missing].map((repoId) =>
      runtime.getWorktreePs(WORKTREE_PS_LIMIT, true, false, undefined, repoId, true)
    )
  )
  if (reads.some((read) => read.truncated)) {
    throw new Error('Could not list every workspace on this host.')
  }
  const found = reads
    .flatMap((read) => read.worktrees)
    .filter((summary) => missing.has(summary.repoId) && !identities.has(summaryIdentity(summary)))
  return found.length ? [...listed, ...found] : listed
}

/** A project's preview with folder siblings in other projects: every listed member, and their groups. */
export async function listProjectFolderSiblings(args: {
  runtime: OrcaRuntimeService
  store: RuntimeStore
  listed: RuntimeWorktreePsSummary[]
  projectId: string
  repos: ReadonlyMap<string, Repo>
  readPairedFolderChildren: () => Promise<PairedFolderChildren>
  strict: boolean
}): Promise<{
  listed: RuntimeWorktreePsSummary[]
  folderSiblingsOf: (summary: RuntimeWorktreePsSummary) => string[]
}> {
  const { runtime, store, projectId, readPairedFolderChildren } = args
  const all = await runtime.getWorktreePs(WORKTREE_PS_LIMIT, true, false)
  if (all.truncated) {
    throw new Error('Could not list every workspace on this host.')
  }
  let listed = [...args.listed, ...all.worktrees.filter((summary) => summary.repoId !== projectId)]
  let folderSiblingsOf = await folderSiblingsByWorktree(store, listed, readPairedFolderChildren)
  if (args.strict) {
    const complete = await listMissingSiblingProjectsStrictly(
      runtime,
      listed,
      projectId,
      args.repos,
      folderSiblingsOf
    )
    if (complete !== listed) {
      listed = complete
      folderSiblingsOf = await folderSiblingsByWorktree(store, listed, readPairedFolderChildren)
    }
  }
  return { listed, folderSiblingsOf }
}
