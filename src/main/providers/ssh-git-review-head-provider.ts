import { isJsonRpcMethodNotFoundError } from './ssh-git-relay-errors'
import { SshGitRemoteSyncProvider } from './ssh-git-remote-sync-provider'

function readDurableReviewHeadLocalRef(
  result: unknown,
  kind: 'pull request' | 'merge request'
): string {
  if (result && typeof result === 'object' && 'localRef' in result) {
    const localRef = (result as { localRef: unknown }).localRef
    if (typeof localRef === 'string') {
      const trimmed = localRef.trim()
      if (trimmed.startsWith('refs/orca/')) {
        return trimmed
      }
    }
  }
  throw new Error(
    `This SSH host did not return the durable ${kind} head ref. Reconnect to deploy the latest relay, then try again.`
  )
}

export class SshGitReviewHeadProvider extends SshGitRemoteSyncProvider {
  async fetchGitLabMergeRequestHead(
    worktreePath: string,
    remote: string,
    mrIid: number
  ): Promise<string> {
    try {
      return await this.runWithGitReadInvalidation(async () => {
        const result = await this.mux.request('git.fetchGitLabMergeRequestHeadRef', {
          worktreePath,
          remote,
          mrIid
        })
        return readDurableReviewHeadLocalRef(result, 'merge request')
      })
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        throw new Error(
          'This SSH host is running an older Orca relay that cannot fetch merge request heads. Reconnect to deploy the latest relay, then try again.'
        )
      }
      throw error
    }
  }

  async fetchGitHubPullRequestHead(
    worktreePath: string,
    remote: string,
    prNumber: number
  ): Promise<string> {
    try {
      return await this.runWithGitReadInvalidation(async () => {
        const result = await this.mux.request('git.fetchGitHubPullRequestHead', {
          worktreePath,
          remote,
          prNumber
        })
        return readDurableReviewHeadLocalRef(result, 'pull request')
      })
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        throw new Error(
          'This SSH host is running an older Orca relay that cannot fetch pull request heads. Reconnect to deploy the latest relay, then try again.'
        )
      }
      throw error
    }
  }
}
