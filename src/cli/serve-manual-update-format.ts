import type { RemoteServerUpdateSupport } from '../shared/remote-server-update'

/**
 * The human `orca status` rendering of a host's update contract. Kept out of the JSON path on
 * purpose: `--json` callers read `runtime.remoteUpdateSupport` directly.
 */
export function formatRemoteUpdateSupportLines(
  support: RemoteServerUpdateSupport | undefined
): string[] {
  if (!support) {
    return []
  }
  const lines = [
    `updateAutomatic: ${support.automatic}`,
    `updateInstallMode: ${support.installMode}`,
    `updateReason: ${support.reason}`
  ]
  const manual = support.manualUpdate
  if (!manual) {
    return lines
  }
  lines.push(`updateMethod: ${manual.method}`)
  lines.push(`updateCheck: ${manual.check}`)
  lines.push(`updateLatestVersion: ${manual.latestVersion ?? 'unknown'}`)
  if (manual.releaseUrl) {
    lines.push(`updateRelease: ${manual.releaseUrl}`)
  }
  if (manual.steps.length > 0) {
    lines.push('updateSteps:')
    // Why: Orca prints these; it never runs them. The serve process is unprivileged by design.
    lines.push(...manual.steps.map((step, index) => `  ${index + 1}. ${step}`))
  }
  lines.push(`updateDocs: ${manual.documentationUrl}`)
  return lines
}
