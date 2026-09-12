import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Why a floor and not just a pin: Electron 43.5.0/43.6.0 set and unset `GDK_GL`
 * around `gtk_init()` while FontConfig warmed up on a pool thread, and below
 * glibc 2.41 that frees `environ` under a concurrent `getenv()` — a launch-time
 * use-after-free on every Ubuntu we support (stablyai/orca#20081). 43.7.0 stops
 * freeing the published `environ`. A downgrade past it re-ships that crash, and
 * nothing else in the tree would notice.
 */
const MINIMUM_ELECTRON_VERSION = '43.7.0'

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
  it.each([
    ['42.9.0', false],
    ['43.6.0', false],
    ['43.7.0', true],
    ['43.7.1', true],
    ['43.8.0', true],
    ['44.0.0', true]
  ])('reads %s as meeting the floor: %s', (specifier, expected) => {
    expect(meetsRuntimeFloor(specifier)).toBe(expected)
  })

  it('pins Electron at or above the glibc environ-race fix', () => {
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
