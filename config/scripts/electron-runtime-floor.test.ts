import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Electron floor preserves Linux environ/getenv UAF fix (43.7.0, #20081) and webview reinsert fix (43.7.4, electron#53989).
// 43.7.8 fixes iframe find-in-page looping (electron#54199); 43.8.1 blocks compromised eMudhra TLS intermediates (GHSA-jr5w-w6x2-84p9);
// 43.8.4 closes File System Access blocklist bypasses and malformed-asar handling (electron#54677, #55331, #55179).
const MINIMUM_ELECTRON_VERSION = '43.8.4'

function parseVersion(specifier: string): [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(specifier)
  if (!match) {
    throw new Error(`unparseable Electron version: ${specifier}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function meetsRuntimeFloor(specifier: string): boolean {
  const version = parseVersion(specifier)
  const floor = parseVersion(MINIMUM_ELECTRON_VERSION)
  for (const [index, part] of version.entries()) {
    if (part !== floor[index]) {
      return part > floor[index]
    }
  }
  return true
}

describe('electron runtime floor', () => {
  it('pins Electron at or above the startup, webview-detach, find-in-page and TLS fixes', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf-8')
    ) as { devDependencies: Record<string, string> }
    const specifier = packageJson.devDependencies.electron

    expect(
      meetsRuntimeFloor(specifier),
      `electron ${specifier} is below the ${MINIMUM_ELECTRON_VERSION} runtime floor`
    ).toBe(true)
  })
})
