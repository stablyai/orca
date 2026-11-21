import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBundleIdentifierFromExecutablePath } from './macos-bundle-identifier'

describe('readBundleIdentifierFromExecutablePath', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function bundleWithPlist(body: string): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-bundle-id-'))
    roots.push(root)
    mkdirSync(join(root, 'Orca.app', 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(root, 'Orca.app', 'Contents', 'Info.plist'), body)
    return join(root, 'Orca.app', 'Contents', 'MacOS', 'Orca')
  }

  it('reads CFBundleIdentifier from the plist beside the executable', () => {
    const exe = bundleWithPlist(
      '<plist><dict>\n<key>CFBundleName</key>\n<string>Orca</string>\n' +
        '<key>CFBundleIdentifier</key>\n\t<string>com.stablyai.orca</string>\n</dict></plist>'
    )

    expect(readBundleIdentifierFromExecutablePath(exe)).toBe('com.stablyai.orca')
  })

  it('returns null when the plist is missing or carries no identifier', () => {
    expect(readBundleIdentifierFromExecutablePath('/nonexistent/App.app/Contents/MacOS/App')).toBe(
      null
    )
    expect(readBundleIdentifierFromExecutablePath(bundleWithPlist('<plist><dict/></plist>'))).toBe(
      null
    )
    expect(
      readBundleIdentifierFromExecutablePath(
        bundleWithPlist('<key>CFBundleIdentifier</key><string></string>')
      )
    ).toBe(null)
  })
})
