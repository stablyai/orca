import type { BrowserWindow } from 'electron'
import { Buffer } from 'node:buffer'
import { lstat } from 'node:fs/promises'
import type { Store } from '../persistence'
import type { GitHubCloneRepoArgs, GitHubCloneRepoResult } from '../../shared/github-account'
import { cloneLocalRepoIntoDestination } from '../ipc/repos/repo-clone-lifecycle'
import { deriveValidatedClonePath } from '../git/repo-clone-path'
import { resolveGitHubToken } from './connection'

const GITHUB_HTTPS_PREFIX = 'https://github.com/'

// Why scoped to `http.https://github.com/`: git only sends the header to that
// URL prefix, so a renderer-supplied clone URL pointing elsewhere can never
// exfiltrate the account token.
function buildCloneAuthConfig(token: string): string {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf-8').toString('base64')
  return `http.${GITHUB_HTTPS_PREFIX}.extraheader=AUTHORIZATION: basic ${basic}`
}

// Why: the panel clones into a fixed default location, so a same-named
// directory is leftover state — abort loudly instead of letting git fail with
// a terse "not an empty directory" or silently reusing an empty one.
async function getExistingCloneTargetError(
  url: string,
  destination: string
): Promise<string | null> {
  let clonePath: string
  try {
    clonePath = deriveValidatedClonePath({ url, destination })
  } catch {
    // Why: cloneLocalRepoIntoDestination re-derives and reports validation errors.
    return null
  }
  try {
    await lstat(clonePath)
  } catch {
    return null
  }
  return `Cannot clone: "${clonePath}" already exists. Remove it first — via the panel's Added menu if Orca manages it, or manually.`
}

export async function cloneGitHubAccountRepo(
  mainWindow: BrowserWindow,
  store: Store,
  args: GitHubCloneRepoArgs
): Promise<GitHubCloneRepoResult> {
  const cloneUrl = args.cloneUrl.trim()
  const destination = args.destination.trim()
  if (!cloneUrl.startsWith(GITHUB_HTTPS_PREFIX) || !destination) {
    return { ok: false, error: 'Invalid GitHub clone request.' }
  }
  const existingTargetError = await getExistingCloneTargetError(cloneUrl, destination)
  if (existingTargetError) {
    return { ok: false, error: existingTargetError }
  }
  let extraGitConfig: string[] | undefined
  if (args.isPrivate) {
    const token = resolveGitHubToken()
    if (!token) {
      return { ok: false, error: 'Connect a GitHub account before cloning private repositories.' }
    }
    extraGitConfig = [buildCloneAuthConfig(token)]
  }
  try {
    const repo = await cloneLocalRepoIntoDestination(
      mainWindow,
      store,
      { url: cloneUrl, destination },
      { extraGitConfig }
    )
    return { ok: true, repo }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
