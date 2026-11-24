import {
  isSameGitRepository,
  isSamePluginSource,
  pluginSourceLabel
} from '../../../shared/plugins/catalog/plugin-marketplace'
import type {
  PluginInstallSource,
  PluginLockEntry,
  PluginLockfile
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import type {
  PluginCliInstallCandidate,
  PluginInstallLocation
} from './plugin-cli-install-candidates'

function locationOf(source: PluginInstallSource): PluginInstallLocation | null {
  switch (source.kind) {
    case 'marketplace':
      return { kind: 'repository', ...source.plugin }
    case 'git':
      return { kind: 'repository', url: source.url }
    case 'local-path':
      return { kind: 'folder', path: source.path }
    case 'bundled':
      return null
  }
}

function locationLabel(location: PluginInstallLocation | null): string {
  if (!location) {
    return 'Orca (bundled)'
  }
  return location.kind === 'folder' ? location.path : pluginSourceLabel(location)
}

/** The repository or folder an install moves from, or null when it stays put. */
export function pluginInstallMove(
  previous: PluginInstallSource,
  next: PluginInstallLocation
): { from: string; to: string } | null {
  const before = locationOf(previous)
  const same =
    before?.kind === 'repository' && next.kind === 'repository'
      ? isSamePluginSource(before, next)
      : before?.kind === 'folder' && next.kind === 'folder' && before.path === next.path
  return same ? null : { from: locationLabel(before), to: locationLabel(next) }
}

/** Matching bytes do not name an install: the same bytes from another repository, folder or
 *  catalog were installed from somewhere else. */
function installedFromSameSource(
  entry: PluginLockEntry,
  candidate: PluginCliInstallCandidate
): boolean {
  if (pluginInstallMove(entry.source, candidate.location) !== null) {
    return false
  }
  if (candidate.source.kind === 'catalog') {
    return (
      entry.source.kind === 'marketplace' &&
      isSameGitRepository(entry.source.marketplace.url, candidate.source.catalog?.url ?? '')
    )
  }
  return entry.source.kind === candidate.source.kind
}

/** The lockfile's record when it is this candidate's install: same plugin, version, bytes and source. */
export function installedRecordOf(
  lockfile: PluginLockfile | null,
  candidate: PluginCliInstallCandidate
): PluginLockEntry | null {
  const entry = lockfile?.plugins[candidate.pluginKey]
  if (
    !entry ||
    entry.version !== candidate.manifest.version ||
    entry.contentHash !== candidate.contentHash ||
    !installedFromSameSource(entry, candidate)
  ) {
    return null
  }
  return entry
}
