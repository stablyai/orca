import { runProcess } from '@orca/process-host'
import { z } from 'zod'
import type { DetectedBrowser } from './installed-browser-catalog'

const OSASCRIPT_PATH = '/usr/bin/osascript'
const OPEN_PATH = '/usr/bin/open'
const LIST_TIMEOUT_MS = 10_000

// LaunchServices lists every app registered for https:, which is how macOS defines a browser.
const LIST_HTTPS_HANDLERS_JXA = `
ObjC.import('AppKit')
const appUrls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsToOpenURL($.NSURL.URLWithString('https://example.com'))
const browsers = []
for (let i = 0; i < appUrls.count; i++) {
  const appUrl = appUrls.objectAtIndex(i)
  const bundle = $.NSBundle.bundleWithURL(appUrl)
  if (bundle.isNil()) continue
  browsers.push({
    id: bundle.bundleIdentifier.js,
    name: $.NSFileManager.defaultManager.displayNameAtPath(appUrl.path).js
  })
}
JSON.stringify(browsers)
`

const jxaBrowserSchema = z.object({ id: z.string(), name: z.string() })

export function parseMacInstalledBrowsers(output: string): DetectedBrowser[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const browsers = new Map<string, DetectedBrowser>()
  for (const entry of parsed) {
    const browser = jxaBrowserSchema.safeParse(entry)
    if (!browser.success) {
      continue
    }
    const id = browser.data.id.trim()
    // Finder shows the .app suffix when the user enables "Show all filename extensions".
    const name = browser.data.name.trim().replace(/\.app$/i, '')
    // The same app can be registered from several locations; keep LaunchServices' first.
    if (!id || !name || browsers.has(id)) {
      continue
    }
    browsers.set(id, {
      id,
      name,
      launchCommand: (url) => ({ program: OPEN_PATH, args: ['-b', id, url], waitForExit: true })
    })
  }
  return [...browsers.values()]
}

export async function readMacInstalledBrowsers(): Promise<DetectedBrowser[]> {
  try {
    const result = await runProcess({
      program: OSASCRIPT_PATH,
      args: ['-l', 'JavaScript', '-e', LIST_HTTPS_HANDLERS_JXA],
      timeoutMs: LIST_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? parseMacInstalledBrowsers(result.stdout) : []
  } catch {
    return []
  }
}
