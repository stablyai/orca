import type { PluginInstallSource } from '../../shared/plugins/plugin-install-lockfile'
import {
  isOfficialOrganizationGitSource,
  isOfficialPluginIdentity,
  isReservedPluginIdentity
} from '../../shared/plugins/plugin-marketplace'

export function pluginInstallTrustError(
  pluginKey: string,
  source: PluginInstallSource
): string | null {
  if (source.kind === 'bundled') {
    return source.bundleId === pluginKey && isOfficialPluginIdentity(pluginKey)
      ? null
      : 'bundled plugins must use an official stablyai.orca-* identity'
  }
  if (!isReservedPluginIdentity(pluginKey)) {
    return null
  }
  if (source.kind === 'local-path') {
    return `reserved plugin identity ${pluginKey} cannot be installed from a local path`
  }
  const url = source.kind === 'git' ? source.url : source.plugin.url
  return isOfficialOrganizationGitSource(url)
    ? null
    : `reserved plugin identity ${pluginKey} must resolve to the stablyai organization`
}
