import type { Repo } from '../../shared/repo-types'
import {
  gitlabMergeRequestHeadLocalRef,
  reviewHeadRemoteRefComponent
} from '../../shared/review-head-tracking-ref'
import { isTransientReviewHeadFetchError } from '../git/fetch-error-classification'
import { fetchGitLabMergeRequestHeadRef } from '../gitlab/mr-head-tracking-ref'
import type { requireSshGitProvider } from '../providers/ssh-git-dispatch'

type SshGitProvider = ReturnType<typeof requireSshGitProvider>
type GitExec = (args: string[]) => Promise<{ stdout: string }>

export async function resolveRuntimeGitLabForkMrBase(args: {
  repo: Repo
  sshGitProvider: SshGitProvider | null
  remote: string
  mrIid: number
  localGitExecOptions?: { cwd: string; wslDistro?: string }
  gitExec: GitExec
  fetchCompareBaseRef: () => Promise<boolean>
  compareBaseRef?: string
}): Promise<{ baseBranch: string; compareBaseRef?: string } | { error: string }> {
  const mrRef = `refs/merge-requests/${args.mrIid}/head`
  let softKeepLocalRefPromise: Promise<string | null> | undefined
  const resolveSoftKeepLocalRef = (): Promise<string | null> => {
    softKeepLocalRefPromise ??= (async () => {
      try {
        const { stdout } = await args.gitExec(['remote', 'get-url', args.remote])
        const remoteUrl = stdout.trim()
        return remoteUrl
          ? gitlabMergeRequestHeadLocalRef(
              reviewHeadRemoteRefComponent(args.remote, remoteUrl),
              args.mrIid
            )
          : null
      } catch {
        return null
      }
    })()
    return softKeepLocalRefPromise
  }
  const resolveDurableHeadSha = async (localRef: string | null): Promise<string | null> => {
    if (!localRef) {
      return null
    }
    try {
      const { stdout } = await args.gitExec(['rev-parse', '--verify', `${localRef}^{commit}`])
      return stdout.trim() || null
    } catch {
      return null
    }
  }
  try {
    const localRef = await fetchGitLabMergeRequestHeadRef(
      args.repo,
      args.sshGitProvider,
      args.remote,
      args.mrIid,
      args.localGitExecOptions ? { localGitExecOptions: args.localGitExecOptions } : {}
    )
    const sha = await resolveDurableHeadSha(localRef)
    if (!sha) {
      return { error: `Could not resolve fork MR !${args.mrIid} head after fetch.` }
    }
    const compareBaseFetched = await args.fetchCompareBaseRef()
    return {
      baseBranch: sha,
      ...(compareBaseFetched ? { compareBaseRef: args.compareBaseRef } : {})
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isTransientReviewHeadFetchError(error)) {
      const localSha = await resolveDurableHeadSha(await resolveSoftKeepLocalRef())
      if (localSha) {
        console.warn(
          '[runtime:resolveManagedMrBase] MR head fetch failed; using durable local ref',
          { remote: args.remote, mrIid: args.mrIid, error: message.split('\n')[0] }
        )
        const compareBaseFetched = await args.fetchCompareBaseRef()
        return {
          baseBranch: localSha,
          ...(compareBaseFetched ? { compareBaseRef: args.compareBaseRef } : {})
        }
      }
    }
    return { error: `Failed to fetch ${mrRef}: ${message.split('\n')[0]}` }
  }
}
