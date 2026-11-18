import { deriveOriginStandInRemoteName } from '../../../shared/git/remotes/git-remote-identity'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { listCachedRemoteNames, type RemoteNameListingGitOptions } from './remote-name-listing'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from './remote-url-probe'

async function readOriginStandInRemoteName(
  repoPath: string,
  connectionId: string | null | undefined,
  localGitOptions: RemoteNameListingGitOptions
): Promise<string | null> {
  const names = await listCachedRemoteNames(repoPath, connectionId, localGitOptions)
  if (!names?.some((name) => name !== 'origin' && name !== 'upstream')) {
    return null
  }
  try {
    const { stdout } = await gitExecFileAsync(['remote', '-v'], {
      cwd: repoPath,
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
    })
    return deriveOriginStandInRemoteName(stdout)
  } catch {
    return null
  }
}

/** Origin's GitHub role falls to the remote project identity reads when origin is missing or a local path. */
export async function resolveOriginWithStandIn<T>(
  repoPath: string,
  connectionId: string | null | undefined,
  localGitOptions: RemoteNameListingGitOptions,
  resolveRemote: (remoteName: string) => Promise<T | null>
): Promise<T | null> {
  const origin = await resolveRemote('origin')
  if (origin !== null) {
    return origin
  }
  const standIn = await readOriginStandInRemoteName(repoPath, connectionId, localGitOptions)
  return standIn ? resolveRemote(standIn) : null
}
