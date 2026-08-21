import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { WorktreePushTargetGit } from './worktree-push-target-git'

export function createSshWorktreePushTargetGit(provider: SshGitProvider): WorktreePushTargetGit {
  return {
    async validateTarget(repoPath, target) {
      assertGitPushTargetShape(target)
      await provider.exec(['check-ref-format', '--branch', target.branchName], repoPath)
    },
    async listRemotes(repoPath) {
      const { stdout } = await provider.exec(['remote'], repoPath)
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    },
    async getRemoteUrl(repoPath, remoteName) {
      return (await provider.exec(['remote', 'get-url', remoteName], repoPath)).stdout.trim()
    },
    async addRemote(repoPath, target) {
      await provider.ensureWorktreePushTargetMutationSupport()
      await provider.addWorktreePushTargetRemote(repoPath, target)
    },
    async fetchRemoteTrackingRef(repoPath, target) {
      await provider.fetchRemoteTrackingRef(
        repoPath,
        target.remoteName,
        target.branchName,
        `refs/remotes/${target.remoteName}/${target.branchName}`,
        { skipAutoMaintenance: true }
      )
    },
    async configureUpstream(worktreePath, branchName, target) {
      await provider.configureWorktreePushTarget(worktreePath, branchName, target)
    },
    async readBranchRemoteConfig(repoPath) {
      return (
        await provider.exec(
          ['config', '--get-regexp', '^branch\\..*\\.(remote|pushRemote)$'],
          repoPath
        )
      ).stdout
    },
    async removeRemoteIfMatches(repoPath, target) {
      await provider.removeWorktreePushTargetRemote(repoPath, target)
    }
  }
}
