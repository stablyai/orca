import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const OFFSCREEN_BACKEND_SOURCE = resolve(__dirname, 'offscreen-browser-backend.ts')

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)

  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)

  return source.slice(startIndex, endIndex)
}

describe('OffscreenBrowserBackend web preferences', () => {
  it('uses the shared browser guest fullscreen policy', () => {
    const source = readFileSync(OFFSCREEN_BACKEND_SOURCE, 'utf8')
    const webPreferencesBlock = sourceBetween(source, 'webPreferences: {', 'partition,')

    expect(source).toContain(
      "import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'"
    )
    expect(webPreferencesBlock).toContain('...ORCA_BROWSER_GUEST_WEB_PREFERENCES')
  })
})
