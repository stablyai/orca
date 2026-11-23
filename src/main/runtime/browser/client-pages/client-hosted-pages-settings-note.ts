import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

export type ClientHostedPagesSettingsNote = { clientHostedPagesNote?: string }

type HostSetting = 'identity' | 'extensions'

// Client-hosted pages render in the paired desktop's engine, so this host's identity and extensions never reach them.
export function clientHostedPagesSettingsNote(
  runtime: WeakKey,
  setting: HostSetting
): ClientHostedPagesSettingsNote {
  if (getRuntimeBrowserPageRegistry(runtime).listPages().length === 0) {
    return {}
  }
  const pages = 'Pages of this host that render on a paired desktop'
  return {
    clientHostedPagesNote:
      setting === 'identity'
        ? `${pages} use that desktop's browser identity, not this host's. Change it there in Settings › Browser.`
        : `${pages} run no extensions.`
  }
}
