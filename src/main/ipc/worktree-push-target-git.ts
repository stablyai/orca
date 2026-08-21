import type { GitPushTarget } from '../../shared/worktree/types'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { sameGitHubRemoteUrl } from '../../shared/git-push-target-remote-url'
import { GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS } from '../../shared/git-fetch-auto-maintenance'
import { REMOTE_TRACKING_FETCH_TIMEOUT_MS } from '../../shared/git-remote-tracking-fetch-timeout'
import { gitExecFileAsync } from '../git/runner'

export type WorktreePushTargetGit = {
  validateTarget(repoPath: string, target: GitPushTarget): Promise<void>
  listRemotes(repoPath: string): Promise<string[]>
  getRemoteUrl(repoPath: string, remoteName: string): Promise<string>
  addRemote(repoPath: string, target: GitPushTarget & { remoteUrl: string }): Promise<void>
  fetchRemoteTrackingRef(repoPath: string, target: GitPushTarget): Promise<void>
  configureUpstream(worktreePath: string, branchName: string, target: GitPushTarget): Promise<void>
  readBranchRemoteConfig(repoPath: string): Promise<string>
  removeRemoteIfMatches(
    repoPath: string,
    target: GitPushTarget & { remoteUrl: string }
  ): Promise<void>
}

type LocalGitOptions = { wslDistro?: string }

export function createLocalWorktreePushTargetGit(
  gitOptions: LocalGitOptions = {}
): WorktreePushTargetGit {
  const exec = (args: string[], cwd: string, options: { timeout?: number } = {}) =>
    gitExecFileAsync(args, { cwd, ...gitOptions, ...options })
  return {
    async validateTarget(repoPath, target) {
      assertGitPushTargetShape(target)
      await exec(['check-ref-format', '--branch', target.branchName], repoPath)
    },
    async listRemotes(repoPath) {
      const { stdout } = await exec(['remote'], repoPath)
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    },
    async getRemoteUrl(repoPath, remoteName) {
      return (await exec(['remote', 'get-url', remoteName], repoPath)).stdout.trim()
    },
    async addRemote(repoPath, target) {
      assertGitPushTargetShape(target)
      await exec(['remote', 'add', target.remoteName, target.remoteUrl], repoPath)
    },
    async fetchRemoteTrackingRef(repoPath, target) {
      await exec(
        [
          ...GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS,
          'fetch',
          target.remoteName,
          `+refs/heads/${target.branchName}:refs/remotes/${target.remoteName}/${target.branchName}`
        ],
        repoPath,
        { timeout: REMOTE_TRACKING_FETCH_TIMEOUT_MS }
      )
    },
    async configureUpstream(worktreePath, branchName, target) {
      assertGitPushTargetShape(target)
      await exec(
        ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, branchName],
        worktreePath
      )
    },
    async readBranchRemoteConfig(repoPath) {
      return (
        await exec(['config', '--get-regexp', '^branch\\..*\\.(remote|pushRemote)$'], repoPath)
      ).stdout
    },
    async removeRemoteIfMatches(repoPath, target) {
      assertGitPushTargetShape(target)
      let configuredUrl: string
      try {
        configuredUrl = (
          await exec(['remote', 'get-url', target.remoteName], repoPath)
        ).stdout.trim()
      } catch {
        // The remote disappeared concurrently; cleanup is best-effort.
        return
      }
      if (sameGitHubRemoteUrl(configuredUrl, target.remoteUrl)) {
        await exec(['remote', 'remove', target.remoteName], repoPath)
      }
    }
  }
}
