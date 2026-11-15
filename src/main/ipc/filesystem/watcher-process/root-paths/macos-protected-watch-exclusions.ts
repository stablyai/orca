/** Keep recursive macOS watches out of other apps' data stores, which macOS guards with a privacy prompt. */
import { realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT } from '../../watchers/filesystem-watcher-ignore'
import type { WatcherProcessSubscribeOptions } from '../parcel-watcher-process-protocol'

type ProtectedExclusionDeps = {
  platform?: NodeJS.Platform
  /** Candidate home directories; defaults to this process's HOME and its account's home. */
  homes?: readonly string[]
  realpath?: (candidate: string) => string
}

function isStrictAncestor(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
}

function hostHomes(): string[] {
  const homes = [homedir()]
  try {
    // A host may run with HOME pointed at a separate profile; the account's own Library still holds other apps' data.
    homes.push(userInfo().homedir)
  } catch {
    // Accounts without a passwd entry only have HOME.
  }
  return homes
}

/** Library paths inside `watchRoot`, which must already be canonical, that a recursive watch must not stat.
 *  Parcel stats each changed path, so a home-rooted watch would prompt once per write another app makes. */
export function macosProtectedWatchExclusions(
  watchRoot: string,
  deps: ProtectedExclusionDeps = {}
): string[] {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return []
  }
  const realpath = deps.realpath ?? realpathSync.native
  const exclusions = new Set<string>()
  for (const home of deps.homes ?? hostHomes()) {
    let library: string
    try {
      // Canonical, like the subscribed root: aliases and case variants would otherwise miss it.
      library = realpath(join(home, 'Library'))
    } catch {
      continue
    }
    if (isStrictAncestor(watchRoot, library)) {
      exclusions.add(library)
      continue
    }
    for (const store of [join(library, 'Containers'), join(library, 'Group Containers')]) {
      if (isStrictAncestor(watchRoot, store)) {
        exclusions.add(store)
      }
    }
  }
  return [...exclusions]
}

/** Add protected stores as literal native exclusions: Parcel would read a path with glob characters as a glob. */
export function withMacosProtectedWatchExclusions(
  watchRoot: string,
  opts: WatcherProcessSubscribeOptions,
  deps: ProtectedExclusionDeps = {}
): WatcherProcessSubscribeOptions {
  if (opts.mode === 'shallow') {
    return opts
  }
  const protectedPaths = macosProtectedWatchExclusions(watchRoot, deps)
  if (protectedPaths.length === 0) {
    return opts
  }
  // FSEvents drops every exclusion past eight; protected paths keep their slots, names keep their regex.
  const nameSlots = Math.max(0, MACOS_FSEVENTS_EXCLUSION_PATH_LIMIT - protectedPaths.length)
  return {
    ...opts,
    ignorePaths: [...protectedPaths, ...(opts.ignorePaths ?? [])],
    ...(opts.ignore ? { ignore: opts.ignore.slice(0, nameSlots) } : {})
  }
}
