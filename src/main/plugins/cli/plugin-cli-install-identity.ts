import {
  isSameGitRepository,
  isSamePluginSource,
  pluginSourceLabel,
  splitQualifiedPluginKey
} from '../../../shared/plugins/catalog/plugin-marketplace'
import { pluginRepositoryOrigin } from '../../../shared/plugins/catalog/plugin-repository-link'
import type {
  PluginInstallSource,
  PluginLockEntry,
  PluginLockfile
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import type { PluginInstallSourceInfo } from '../../../shared/plugins/installation/plugin-install-source-info'
import { gitUrlPluginPublisher } from '../../../shared/plugins/installation/plugin-publisher-derivation'
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

/** Where the durable record says its bytes came from; null for a bundled record, which names no source. */
export function recordedSourceInfo(entry: PluginLockEntry): PluginInstallSourceInfo | null {
  const { source } = entry
  const repository = (url: string, ref: string, path?: string): PluginInstallSourceInfo => ({
    kind: 'git',
    official: false,
    publisher: gitUrlPluginPublisher(url),
    repository: pluginRepositoryOrigin(url, path)?.repository ?? null,
    url,
    ref,
    commit: entry.resolvedCommit,
    path: null,
    catalog: null
  })
  switch (source.kind) {
    case 'bundled':
      return null
    case 'local-path':
      return {
        kind: 'local-path',
        official: false,
        publisher: null,
        repository: null,
        url: null,
        ref: null,
        commit: null,
        path: source.path,
        catalog: null
      }
    case 'git':
      return repository(source.url, source.ref)
    case 'marketplace':
      return {
        ...repository(source.plugin.url, source.plugin.ref, source.plugin.path),
        kind: 'catalog',
        publisher: splitQualifiedPluginKey(entry.pluginKey)?.publisher ?? null
      }
  }
}

/** True when the record names another repository or commit than the requested install did. */
export function recordDiffersFromRequest(
  entry: PluginLockEntry,
  candidate: PluginCliInstallCandidate
): boolean {
  return (
    pluginInstallMove(entry.source, candidate.location) !== null ||
    entry.resolvedCommit !== candidate.resolvedCommit
  )
}
