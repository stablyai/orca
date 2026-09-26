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
    // Why: keep "reserved plugin identity" as the stable error prefix for UI matching,
    // and spell out the fork-and-test fix so the dialog is actionable (#12598).
    return (
      `reserved plugin identity ${pluginKey} cannot be installed from a local path. ` +
      `Forked official templates still use publisher "stablyai" and/or an id starting with "orca-". ` +
      `Change publisher and id in orca-plugin.json to your own identity before local testing.`
    )
  }
  const url = source.kind === 'git' ? source.url : source.plugin.url
  return isOfficialOrganizationGitSource(url)
    ? null
    : `reserved plugin identity ${pluginKey} must resolve to the stablyai organization. ` +
        `Forks must either publish from github.com/stablyai/... or rename publisher/id away from the reserved namespace.`
}
