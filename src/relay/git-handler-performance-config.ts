import { resolve } from 'node:path'
import { expandTilde } from './context'
import { GitHandlerOperationContext } from './git-handler-operation-context'
import { detectReliableDirectoryMtime } from '../shared/git-performance-config-filesystem'
import {
  runGitPerformanceConfigAction,
  type GitPerformanceConfigHost
} from '../shared/git-performance-config-runner'
import {
  isGitPerformanceConfigAction,
  isGitPerformanceConfigKey,
  type GitPerformanceConfigOptions,
  type GitPerformanceConfigResult
} from '../shared/git-performance-config-types'
import { KeyedSerialRunner } from '../shared/keyed-serial-runner'

// Both fields are optional so a missing one keeps the safe default: no file watcher, full revert.
function parseOptions(params: Record<string, unknown>): GitPerformanceConfigOptions {
  const { fsmonitor, keys } = params
  if (fsmonitor !== undefined && typeof fsmonitor !== 'boolean') {
    throw new Error('Invalid repository performance config request.')
  }
  if (keys !== undefined && (!Array.isArray(keys) || !keys.every(isGitPerformanceConfigKey))) {
    throw new Error('Invalid repository performance config request.')
  }
  return { ...(fsmonitor ? { fsmonitor } : {}), ...(keys ? { keys } : {}) }
}

// Why a narrow RPC: generic git.exec refuses config writes, and the plan must be made
// host-side because the SSH host's Git version, OS and filesystem decide every key.
export class GitHandlerPerformanceConfigOperations extends GitHandlerOperationContext {
  private readonly perRepo = new KeyedSerialRunner()

  async repoPerformanceConfig(
    params: Record<string, unknown>
  ): Promise<GitPerformanceConfigResult> {
    const repoPath = params.repoPath
    const action = params.action
    if (typeof repoPath !== 'string' || !repoPath || repoPath.includes('\0')) {
      throw new Error('Invalid repository performance config request.')
    }
    if (!isGitPerformanceConfigAction(action)) {
      throw new Error('Unknown repository performance config action.')
    }
    const options = parseOptions(params)
    const hostPath = expandTilde(repoPath)
    const host: GitPerformanceConfigHost = {
      platform: process.platform,
      git: (args) => this.git(args, hostPath, { nonInteractive: true }),
      capabilities: this.gitCapabilities,
      hasReliableDirectoryMtime: () => detectReliableDirectoryMtime(hostPath, process.platform),
      resolveGitPath: (gitPath) => resolve(hostPath, gitPath)
    }
    return this.perRepo.run(hostPath, () => runGitPerformanceConfigAction(host, action, options))
  }
}
