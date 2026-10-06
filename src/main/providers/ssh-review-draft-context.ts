import type { getPullRequestDraftContext } from '../text-generation/pull-request-context'
import type { SshGitProvider } from './ssh-git-provider'

type DraftExecOptions = Parameters<Parameters<typeof getPullRequestDraftContext>[0]>[1]

export async function execSshReviewDraft(
  provider: Pick<SshGitProvider, 'exec' | 'fetchRemoteTrackingRef' | 'readReviewDiff'>,
  args: string[],
  cwd: string,
  commandOptions?: DraftExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = commandOptions?.timeoutMs ?? commandOptions?.timeout
  const options = timeoutMs === undefined ? undefined : { timeoutMs }
  if (args.length === 4 && args[0] === 'fetch' && args[1] === '--no-tags') {
    const match = /^\+refs\/heads\/([^:]+):(.+)$/.exec(args[3])
    if (match && match[2] === `refs/remotes/${args[2]}/${match[1]}`) {
      await provider.fetchRemoteTrackingRef(cwd, args[2], match[1], match[2])
      return { stdout: '', stderr: '' }
    }
  }
  const range = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\.\.HEAD$/i.exec(args.at(-1) ?? '')
  if (args[0] === 'diff' && range) {
    const flags = args.slice(1, -1).join('\0')
    const format =
      flags === '--name-status'
        ? 'name-status'
        : flags === '--patch\0--minimal\0--no-color\0--no-ext-diff'
          ? 'patch'
          : null
    if (format) {
      return provider.readReviewDiff(cwd, range[1], format, options)
    }
  }
  return options ? provider.exec(args, cwd, options) : provider.exec(args, cwd)
}
