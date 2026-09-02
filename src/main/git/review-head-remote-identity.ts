import { gitExecFileAsync } from './runner'
import { reviewHeadRemoteRefComponent } from '../../shared/review-head-tracking-ref'

type LocalGitExecOptions = {
  cwd: string
  wslDistro?: string
}

// Why: the durable review-head ref embeds the remote's identity, and a missing
// remote must fail with an actionable message instead of a raw fetch error.
export async function getReviewHeadRemoteComponent(
  remote: string,
  localGitExecOptions: LocalGitExecOptions
): Promise<string> {
  let remoteUrl: string
  try {
    const { stdout } = await gitExecFileAsync(['remote', 'get-url', remote], localGitExecOptions)
    remoteUrl = stdout.trim()
  } catch {
    remoteUrl = ''
  }
  if (!remoteUrl) {
    throw new Error(`Remote "${remote}" is not configured.`)
  }
  return reviewHeadRemoteRefComponent(remote, remoteUrl)
}
