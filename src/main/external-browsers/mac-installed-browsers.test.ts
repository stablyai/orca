import { describe, expect, it } from 'vitest'
import { parseMacInstalledBrowsers } from './mac-installed-browsers'

describe('parseMacInstalledBrowsers', () => {
  it('reads bundle ids and display names and launches through open -b', () => {
    const browsers = parseMacInstalledBrowsers(
      JSON.stringify([
        { id: 'com.apple.Safari', name: 'Safari' },
        { id: 'com.google.Chrome', name: 'Google Chrome.app' }
      ])
    )

    expect(browsers.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'com.apple.Safari', name: 'Safari' },
      { id: 'com.google.Chrome', name: 'Google Chrome' }
    ])
    expect(browsers[1].launchCommand('https://example.com/a?b=1')).toEqual({
      program: '/usr/bin/open',
      args: ['-b', 'com.google.Chrome', 'https://example.com/a?b=1'],
      waitForExit: true
    })
  })

  it.each([
    ['empty output', ''],
    ['invalid JSON', 'execution error: -2700'],
    ['a non-array', '{"id":"com.apple.Safari"}']
  ])('yields an empty list for %s', (_label, output) => {
    expect(parseMacInstalledBrowsers(output)).toEqual([])
  })
})
