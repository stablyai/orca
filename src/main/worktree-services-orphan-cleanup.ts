import { loadHooks } from './hooks'
import { destroyWorktreeServices } from './worktree-services'
import {
  listWorktreeServicesRecords,
  removeWorktreeServicesRecord,
  upsertWorktreeServicesRecord
} from '../shared/worktree-services-store'
import type { Repo } from '../shared/types'

export async function cleanupOrphanedWorktreeServices(args: {
  userDataPath: string
  existingWorktreeIds: Set<string>
  resolveRepo: (repoId: string) => Repo | null
}): Promise<void> {
  for (const record of listWorktreeServicesRecords(args.userDataPath)) {
    if (args.existingWorktreeIds.has(record.worktreeId)) {
      // Why: a provision interrupted by app exit persists 'provisioning' forever
      // — the worktree still exists (so it's not an orphan) but retry is only
      // offered for create_failed. Demote it so the badge/panel offer a retry.
      if (record.status === 'provisioning') {
        upsertWorktreeServicesRecord(args.userDataPath, {
          ...record,
          status: 'create_failed',
          error:
            'Provisioning was interrupted when Orca exited. Retry to finish setting up services.',
          updatedAt: new Date().toISOString()
        })
      }
      continue
    }
    const repo = args.resolveRepo(record.repoId)
    const services = repo ? (loadHooks(repo.path)?.services ?? []) : []
    if (repo && services.length > 0) {
      await destroyWorktreeServices({
        userDataPath: args.userDataPath,
        worktreeId: record.worktreeId,
        // Why: the worktree directory is gone at cleanup time; destroy commands
        // reference the project slug and run from the repo root, which holds the
        // compose file.
        worktreePath: repo.path,
        repo,
        services
      })
    } else {
      // Why: recipes are unavailable (repo removed), so freeing the slot beats
      // leaking it forever.
      removeWorktreeServicesRecord(args.userDataPath, record.worktreeId)
    }
  }
}
