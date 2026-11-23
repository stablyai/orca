import { BrowserError } from '../../../browser/browser-error'

const STALE_PAGE =
  'The page was reloaded, closed or moved on the desktop while this command ran. Check it with `orca tab list`, then retry.'

// Desktops and this host refuse client-page commands with bare codes; agents read these sentences instead.
const BROWSER_CLIENT_PAGE_REFUSAL_COPY: Record<string, string> = {
  // Only a desktop older than this host's path-free download refuses it.
  browser_client_download_path_unsupported:
    'The desktop showing this page runs an older Orca that cannot hand its downloads to this host, so `orca download` cannot save the file here. Update Orca on that desktop. Nothing was downloaded.',
  browser_client_file_channel_unsupported:
    'The desktop showing this page cannot exchange files with this host, so `orca upload` and `orca download` cannot run on it. Update Orca on that desktop and on this host.',
  browser_host_capability_unavailable:
    'The desktop showing this page cannot run agent commands on it. Update Orca on that desktop.',
  browser_client_page_generation_stale: STALE_PAGE,
  browser_client_page_automation_registration_stale: STALE_PAGE,
  browser_client_page_renderer_stale: STALE_PAGE,
  browser_page_placement_stale: STALE_PAGE,
  browser_client_page_command_aborted:
    'The desktop stopped this command before it finished. Retry it.',
  browser_client_page_command_failed: 'The desktop showing this page could not run this command.'
}

export function browserClientPageRefusal(code: string, message?: string): BrowserError {
  // Hosts often refuse with the bare code as the message; that is no detail.
  const detail = message === code ? undefined : message
  return new BrowserError(code, detail ?? BROWSER_CLIENT_PAGE_REFUSAL_COPY[code] ?? code)
}

/** Plain refusals carry only their code as the message; give known ones readable text. */
export function readableBrowserClientPageRefusal(error: unknown): unknown {
  if (
    error instanceof Error &&
    !(error instanceof BrowserError) &&
    Object.hasOwn(BROWSER_CLIENT_PAGE_REFUSAL_COPY, error.message)
  ) {
    return browserClientPageRefusal(error.message)
  }
  return error
}

export function unresponsiveHostMessage(deviceName: string | null | undefined): string {
  const desktop = deviceName ? `The Orca desktop "${deviceName}"` : 'The paired Orca desktop'
  return `${desktop} didn't respond when this server asked it to host browser pages; it may be asleep or disconnected. Wake it and retry, or open a browser tab in one of this server's workspaces on the desktop you want to use.`
}
