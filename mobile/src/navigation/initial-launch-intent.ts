type LaunchSource = 'pairing-link' | 'notification'

const launchIntent = { discarded: false, consumedSources: new Set<LaunchSource>() }

export function consumeInitialLaunchIntent(
  source: LaunchSource
): { readonly discarded: boolean } | null {
  if (launchIntent.discarded || launchIntent.consumedSources.has(source)) {
    return null
  }
  launchIntent.consumedSources.add(source)
  return launchIntent
}

export function discardInitialLaunchIntent(): void {
  launchIntent.discarded = true
}
