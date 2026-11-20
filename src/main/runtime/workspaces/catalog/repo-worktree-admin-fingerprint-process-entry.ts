import { readRepoWorktreeAdminFingerprint } from './repo-worktree-admin-fingerprint-read'
import type {
  RepoFingerprintRequest,
  RepoFingerprintResponse
} from './repo-worktree-admin-fingerprint-protocol'

process.on('message', (request: RepoFingerprintRequest) => {
  void readRepoWorktreeAdminFingerprint(request.repoPath).then((fingerprint) => {
    const response: RepoFingerprintResponse = { id: request.id, fingerprint }
    if (process.connected) {
      process.send?.(response, () => undefined)
    }
  })
})
process.once('disconnect', () => process.exit(0))
