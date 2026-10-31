import { BROWSER_EXTENSION_CONTENT_SCRIPT_FILE } from '../../../shared/browser-extension-worker-api'

type Manifest = Record<string, unknown>
type ScriptEntry = { js: unknown[] }

function runsInIsolatedWorld(entry: unknown): entry is ScriptEntry {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    'js' in entry &&
    Array.isArray(entry.js) &&
    entry.js.length > 0 &&
    !('world' in entry && entry.world === 'MAIN')
  )
}

/**
 * Lists Orca's content script first in each manifest content script that runs in the extension's
 * isolated world, so Orca's content-script APIs exist before the extension's own scripts run at
 * that entry's run_at. MAIN-world scripts have no extension APIs to fix. Null when no content
 * script runs there.
 */
export function withOrcaContentScript(manifest: Manifest): Manifest | null {
  const entries = manifest.content_scripts
  if (!Array.isArray(entries) || !entries.some(runsInIsolatedWorld)) {
    return null
  }
  return {
    ...manifest,
    content_scripts: entries.map((entry: unknown) =>
      runsInIsolatedWorld(entry)
        ? { ...entry, js: [BROWSER_EXTENSION_CONTENT_SCRIPT_FILE, ...entry.js] }
        : entry
    )
  }
}
