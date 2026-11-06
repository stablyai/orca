import { pluginExecutionProfile } from '../../../shared/plugins/contributions/plugin-execution-profile'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'

/**
 * One-click install for content-only plugins. Why main decides: the click counts as consent only
 * for plugins that cannot run anything, and that must be read from the installed, verified
 * manifest, never from what the renderer claims. Anything else stays pending for review.
 */
export async function enableIfDataPlugin(input: {
  pluginKey: string
  /** Fingerprint of the bytes just installed; approval binds to exactly these. */
  installedFingerprint: string
  /** The fingerprint the user was shown at preview; when given, nothing else is approved. */
  expectedFingerprint?: string
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  approve: (pluginKey: string, reviewedFingerprint: string) => Promise<void>
}): Promise<{ needsReview: boolean }> {
  const plugin = input.findValidPlugin(input.pluginKey)
  if (
    !plugin ||
    // Why: a development override shadows the install, so it is not the bytes just reviewed.
    plugin.isDev ||
    plugin.consentFingerprint !== input.installedFingerprint ||
    (input.expectedFingerprint !== undefined &&
      input.expectedFingerprint !== input.installedFingerprint) ||
    pluginExecutionProfile(plugin.manifest) !== 'data'
  ) {
    return { needsReview: true }
  }
  await input.approve(input.pluginKey, plugin.consentFingerprint)
  return { needsReview: false }
}
