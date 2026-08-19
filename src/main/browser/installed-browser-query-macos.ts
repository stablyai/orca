import { execFileSync } from 'node:child_process'
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

function runOsascript(): string {
  return execFileSync('osascript', ['-l', 'JavaScript', '-e', HTTPS_HANDLERS_JXA], {
    encoding: 'utf-8',
    timeout: 5_000
  })
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
export function queryHttpsHandlersMacOS(
  run: () => string = runOsascript
): DiscoveredBrowserCandidate[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(run())
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed.filter(isCandidate)
}
