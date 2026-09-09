// Why: namespace import (not `{ execFile }`) so tests that partially mock
// node:child_process (execFileSync only) still load this transitively-imported module —
// execFile is only touched when runOsascript actually runs.
import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import type { DiscoveredBrowserCandidate } from './installed-browser-discovery'

// JXA (osascript) calling LaunchServices: enumerate apps registered to open https —
// i.e. installed browsers. osascript ships on every macOS, so no bundled binary.
// Values are passed as argv (never shell-interpolated); the script is read-only.
const HTTPS_HANDLERS_JXA = `
ObjC.import("CoreServices");
ObjC.import("AppKit");
var ws = $.NSWorkspace.sharedWorkspace;
var ref = $.LSCopyAllHandlersForURLScheme($("https"));
var arr = ObjC.castRefToObject(ref);
var out = [];
var n = arr.count;
for (var i = 0; i < n; i++) {
  var bid = ObjC.unwrap(arr.objectAtIndex(i));
  var url = ws.URLForApplicationWithBundleIdentifier($(bid));
  if (!url) { continue; }
  var name = ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(url.path));
  out.push({ bundleId: bid, displayName: name, appPath: ObjC.unwrap(url.path) });
}
JSON.stringify(out);
`

// Why: async so detection never blocks the main/runtime event loop — this runs on
// every detect/import call and JXA/AppKit spin-up can take a moment.
async function runOsascript(): Promise<string> {
  const execFileAsync = promisify(childProcess.execFile)
  const { stdout } = await execFileAsync(
    'osascript',
    ['-l', 'JavaScript', '-e', HTTPS_HANDLERS_JXA],
    { timeout: 5_000 }
  )
  return stdout.toString()
}

function isCandidate(value: unknown): value is DiscoveredBrowserCandidate {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    typeof record.bundleId === 'string' &&
    typeof record.displayName === 'string' &&
    typeof record.appPath === 'string'
  )
}

// Parse the osascript JSON into candidates; any malformed output degrades to [].
// `run` is injectable so the parsing is unit-tested without touching the OS.
export async function queryHttpsHandlersMacOS(
  run: () => Promise<string> = runOsascript
): Promise<DiscoveredBrowserCandidate[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await run())
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed.filter(isCandidate)
}
