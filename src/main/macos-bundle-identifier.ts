import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** `<bundle>/Contents/MacOS/<exe>` → `<bundle>/Contents/Info.plist`. */
export function readBundleIdentifierFromExecutablePath(execPath: string): string | null {
  try {
    const plist = readFileSync(join(dirname(dirname(execPath)), 'Info.plist'), 'utf8')
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)
    const identifier = match?.[1]?.trim()
    return identifier ? identifier : null
  } catch {
    return null
  }
}

let cachedIdentifier: string | null | undefined

/**
 * The running bundle's own identifier, so anything keyed on app identity — TCC attribution, the
 * preferences domain, a System Settings deep link — addresses this build rather than a constant.
 * Null off a packaged macOS bundle, where there is no Info.plist to read.
 */
export function getMacBundleIdentifier(): string | null {
  if (cachedIdentifier === undefined) {
    cachedIdentifier = readBundleIdentifierFromExecutablePath(process.execPath)
  }
  return cachedIdentifier
}
