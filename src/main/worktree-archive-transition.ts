import type { RuntimeStore } from './runtime/runtime-store-contract'
import type { HostWorktreeTarget } from '../shared/worktree/host-qualified-identity'
import { splitWorktreeId } from '../shared/worktree/id'
import { isRepoOnCatalogHost } from '../shared/execution-host'
import { isFolderRepo } from '../shared/repo-kind'
import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from './worktree-removal-repo-owner'
import { runSerializedWorktreeRemovalAcceptance } from './worktree-removal-acceptance-queue'
import { getLocalProjectWorktreeGitOptions } from './project-runtime-git-options'
import { getEffectiveHooks, runHook } from './hooks'
import { waitForPendingWorktreeRemoval } from './worktree-background-removal'

/** Share acceptance with deletion; archive keeps the checkout and only commits after confirmed stop. */
export async function writeWorktreeArchiveTransition<T>(args: {
  store: RuntimeStore
  target: HostWorktreeTarget
  isArchived: boolean
  expectedInstanceId?: string
  write: () => T | Promise<T>
}): Promise<T> {
  const { store, target } = args
  const locator = splitWorktreeId(target.id)
  if (!locator) {
    throw new Error('Cannot archive a workspace whose checkout identity is unknown.')
  }
  const owner = resolveWorktreeRemovalRepoOwner(store, locator.repoId, target.hostId)
  if (owner.kind !== 'resolved' || !isRepoOnCatalogHost(owner.repo)) {
    throw new Error(
      'Cannot archive this workspace on the selected host. Connect to its execution host and retry.'
    )
  }
  if (isFolderRepo(owner.repo)) {
    return args.write()
  }
  const readMeta = () =>
    store.getWorktreeMetaForHost
      ? store.getWorktreeMetaForHost(target.id, target.hostId)
      : resolveWorktreeRemovalMetadata(store, locator.repoId, target.id, target.hostId)
  const expectedInstanceId = args.expectedInstanceId ?? readMeta()?.instanceId
  const assertCurrent = () => {
    if (waitForPendingWorktreeRemoval(target.id, target.hostId)) {
      throw new Error('Cannot change archive state while workspace deletion is in progress.')
    }
    const currentOwner = resolveWorktreeRemovalRepoOwner(store, locator.repoId, target.hostId)
    const meta = readMeta()
    if (
      (expectedInstanceId !== undefined && meta?.instanceId !== expectedInstanceId) ||
      currentOwner.kind !== 'resolved' ||
      currentOwner.repo.path !== owner.repo.path
    ) {
      throw new Error(
        'The workspace instance changed or could not be verified during archive. Refresh and retry.'
      )
    }
    return meta
  }
  return runSerializedWorktreeRemovalAcceptance(owner.repo.path, async () => {
    const current = assertCurrent()
    if (args.isArchived && !current?.isArchived) {
      const hooks = getEffectiveHooks(owner.repo, undefined, { strictArchive: true })
      const commands =
        hooks?.archiveCommands ?? (hooks?.scripts.archive ? [hooks.scripts.archive] : [])
      if (commands.length > 0 && !args.expectedInstanceId) {
        throw Object.assign(
          new Error(
            'Archive requires the selected workspace instance. Refresh it in an updated client or select its canonical identity before retrying; no stop hook ran.'
          ),
          {
            code: 'worktree_archive_identity_required'
          }
        )
      }
      const runtime = getLocalProjectWorktreeGitOptions(store, owner.repo)
      for (const command of commands) {
        assertCurrent()
        const result = await runHook(
          'archive',
          locator.worktreePath,
          owner.repo,
          undefined,
          runtime,
          undefined,
          command
        )
        if (!result.success) {
          throw Object.assign(
            new Error(
              `Archive hook did not confirm stopped execution. The workspace remains unarchived. ${result.output.trim()}`
            ),
            {
              code: 'worktree_archive_transition_failed',
              data: result
            }
          )
        }
      }
    }
    assertCurrent()
    return args.write()
  })
}
