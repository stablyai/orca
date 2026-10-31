import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareAppVersions, isValidAppVersion } from '../../../shared/app-version'
import { isSafePluginGitRef } from '../../../shared/plugins/installation/plugin-git-install-input'
import { isAllowedPluginGitUrl } from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  pluginGitConfigArgs,
  pluginGitListRefsArgs,
  pluginGitRemoteHeadArgs
} from '../../../shared/plugins/installation/plugin-git-arguments'
import type {
  PluginGitResolution,
  PluginGitSourceResolution
} from '../../../shared/plugins/installation/plugin-git-resolution'
import { runPluginGit } from './plugin-git-repository'

const SHA1_COMMIT_PATTERN = /^[0-9a-f]{40}$/

type RemoteRefs = { tags: Map<string, string>; branches: Map<string, string> }

/** Commit per tag (peeled `^{}` lines win over annotated tag objects) and per branch. */
export function parsePluginGitRemoteRefs(output: string): RemoteRefs {
  const tags = new Map<string, string>()
  const branches = new Map<string, string>()
  const peeled = new Set<string>()
  for (const line of output.split('\n')) {
    const [sha, name] = line.trim().split('\t')
    if (!sha || !name || !SHA1_COMMIT_PATTERN.test(sha)) {
      continue
    }
    if (name.startsWith('refs/heads/')) {
      branches.set(name.slice('refs/heads/'.length), sha)
    } else if (name.startsWith('refs/tags/')) {
      const isPeeled = name.endsWith('^{}')
      const tag = name.slice('refs/tags/'.length, isPeeled ? -3 : undefined)
      if (isPeeled || !peeled.has(tag)) {
        tags.set(tag, sha)
      }
      if (isPeeled) {
        peeled.add(tag)
      }
    }
  }
  return { tags, branches }
}

/** Newest `vX.Y.Z` / `X.Y.Z` tag; prereleases only when the repository has no stable tag. */
export function newestPluginVersionTag(tags: Iterable<string>): string | null {
  const versions = [...tags].filter(isValidAppVersion)
  const stable = versions.filter((tag) => !/-/.test(tag.replace(/\+.*$/, '')))
  const candidates = stable.length > 0 ? stable : versions
  return candidates.reduce<string | null>(
    (newest, tag) => (newest === null || compareAppVersions(tag, newest) > 0 ? tag : newest),
    null
  )
}

export function resolvePluginGitRefFromRemote(
  refs: RemoteRefs,
  ref: string
): PluginGitResolution | null {
  if (!ref) {
    const tag = newestPluginVersionTag(refs.tags.keys())
    return tag ? { kind: 'latest-tag', ref: tag, commit: refs.tags.get(tag)! } : null
  }
  const tagCommit = refs.tags.get(ref)
  if (tagCommit) {
    return { kind: 'tag', ref, commit: tagCommit }
  }
  const branchCommit = refs.branches.get(ref)
  return branchCommit ? { kind: 'branch', ref, commit: branchCommit } : null
}

/**
 * Pins what the install dialog shows to an exact commit before anything downloads. An empty ref
 * means the newest version tag, or the default branch's current commit when there is none.
 */
export async function resolvePluginGitSource(input: {
  url: string
  ref: string
}): Promise<PluginGitSourceResolution> {
  const ref = input.ref.trim()
  if (!isAllowedPluginGitUrl(input.url) || (ref && !isSafePluginGitRef(ref))) {
    return { ok: false, reason: 'unreachable', error: 'invalid plugin Git source' }
  }
  if (SHA1_COMMIT_PATTERN.test(ref)) {
    return { ok: true, url: input.url, kind: 'commit', ref, commit: ref }
  }
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-ls-remote-'))
  // Why the same -c policy as the download: ls-remote also follows insteadOf rewrites.
  const listRemote = (args: string[]): Promise<string> =>
    runPluginGit([...pluginGitConfigArgs(join(temporaryRoot, 'no-hooks')), ...args], temporaryRoot)
  try {
    const refs = parsePluginGitRemoteRefs(await listRemote(pluginGitListRefsArgs(input.url)))
    const resolved = resolvePluginGitRefFromRemote(refs, ref)
    if (resolved) {
      return { ok: true, url: input.url, ...resolved }
    }
    if (ref) {
      return { ok: false, reason: 'ref-not-found', ref }
    }
    const head = (await listRemote(pluginGitRemoteHeadArgs(input.url))).split('\t')[0]?.trim() ?? ''
    if (!SHA1_COMMIT_PATTERN.test(head)) {
      return { ok: false, reason: 'unreachable', error: 'repository has no commits' }
    }
    return { ok: true, url: input.url, kind: 'default-branch', ref: head, commit: head }
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      error: error instanceof Error ? error.message : String(error)
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
