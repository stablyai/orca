import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const {
  assertNoDarkOutputOfOffSwitches,
  assertNotDarkBuild,
  assertReleaseDesktopBuild,
  desktopBuildDefines,
  darkBuildMarkerFileNames,
  darkBuildMarkers,
  desktopBuildMarkers,
  shippedDesktopDefines,
  turnedOnDarkBuildDefines
} = createRequire(import.meta.url)('../dark-build-switches.cjs')

const scratch = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function markedDir(marker) {
  const dir = await mkdtemp(join(tmpdir(), 'orca-build-switch-marked-'))
  scratch.push(dir)
  await writeFile(join(dir, marker.fileName), marker.text)
  return dir
}

describe('layout owner: shipped on in the desktop app', () => {
  it('compiles the path in unless ORCA_LAYOUT_OWNER=window asks for the rollback variant', () => {
    expect(desktopBuildDefines({}).ORCA_LAYOUT_OWNER).toBe('"main"')
    expect(desktopBuildDefines({ ORCA_LAYOUT_OWNER: 'main' }).ORCA_LAYOUT_OWNER).toBe('"main"')
    expect(desktopBuildDefines({ ORCA_LAYOUT_OWNER: 'window' }).ORCA_LAYOUT_OWNER).toBe('"window"')
    expect(shippedDesktopDefines()).toEqual({ ORCA_LAYOUT_OWNER: '"main"' })
    expect(() => desktopBuildDefines({ ORCA_LAYOUT_OWNER: 'off' })).toThrow('ORCA_LAYOUT_OWNER=off')
  })

  it('marks only the rollback variant', () => {
    expect(desktopBuildMarkers({})).toEqual([])
    expect(desktopBuildMarkers({ ORCA_LAYOUT_OWNER: 'main' })).toEqual([])
    expect(desktopBuildMarkers({ ORCA_LAYOUT_OWNER: 'window' })).toEqual([
      {
        fileName: 'ORCA_LAYOUT_OWNER_WINDOW',
        text: 'Built with ORCA_LAYOUT_OWNER=window, the rollback variant, for testing only.\n'
      }
    ])
    // The phone page reads no layout switch, so no build of it is marked for one.
    expect(darkBuildMarkers({ ORCA_LAYOUT_OWNER: 'main' })).toEqual([])
    expect(darkBuildMarkers({ ORCA_LAYOUT_OWNER: 'window' })).toEqual([])
  })

  it('refuses to package the rollback variant or its output, never the default', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'orca-build-switch-clean-'))
    scratch.push(clean)
    const [marker] = desktopBuildMarkers({ ORCA_LAYOUT_OWNER: 'window' })
    const rollback = await markedDir(marker)

    expect(() => assertReleaseDesktopBuild([clean], {})).not.toThrow()
    expect(() => assertReleaseDesktopBuild([clean], { ORCA_LAYOUT_OWNER: 'main' })).not.toThrow()
    expect(() => assertReleaseDesktopBuild([clean], { ORCA_LAYOUT_OWNER: 'window' })).toThrow(
      'ORCA_LAYOUT_OWNER=window'
    )
    expect(() => assertReleaseDesktopBuild([clean, rollback], {})).toThrow(rollback)
  })

  it('stays off in orcad unless a test build asks, which the server template refuses', () => {
    expect(turnedOnDarkBuildDefines({})).toEqual({})
    expect(turnedOnDarkBuildDefines({ ORCA_LAYOUT_OWNER: 'window' })).toEqual({})
    expect(turnedOnDarkBuildDefines({ ORCA_LAYOUT_OWNER: 'main' })).toEqual({
      ORCA_LAYOUT_OWNER: '"main"'
    })
    expect(() => assertNotDarkBuild([], {})).not.toThrow()
    expect(() => assertNotDarkBuild([], { ORCA_LAYOUT_OWNER: 'window' })).not.toThrow()
    expect(() => assertNotDarkBuild([], { ORCA_LAYOUT_OWNER: 'main' })).toThrow(
      'ORCA_LAYOUT_OWNER=main'
    )
  })
})

describe('sidebar inputs: still dark', () => {
  it('compiles the dark path in only when ORCA_SIDEBAR_INPUTS=main asks', () => {
    expect(desktopBuildDefines({ ORCA_SIDEBAR_INPUTS: 'main' }).ORCA_SIDEBAR_INPUTS).toBe('"main"')
    expect(desktopBuildDefines({ ORCA_SIDEBAR_INPUTS: 'window' }).ORCA_SIDEBAR_INPUTS).toBe(
      '"window"'
    )
    expect(desktopBuildDefines({}).ORCA_SIDEBAR_INPUTS).toBe('"window"')
    expect(turnedOnDarkBuildDefines({ ORCA_SIDEBAR_INPUTS: 'main' })).toEqual({
      ORCA_SIDEBAR_INPUTS: '"main"'
    })
    expect(shippedDesktopDefines()).not.toHaveProperty('ORCA_SIDEBAR_INPUTS')
  })

  it('keeps the marker name packaging already refuses, in out/main and the phone page', () => {
    const marker = {
      fileName: 'ORCA_SIDEBAR_INPUTS_MAIN',
      text: 'Built with ORCA_SIDEBAR_INPUTS=main, for dark testing only.\n'
    }
    expect(desktopBuildMarkers({ ORCA_SIDEBAR_INPUTS: 'main' })).toEqual([marker])
    expect(darkBuildMarkers({ ORCA_SIDEBAR_INPUTS: 'main' })).toEqual([marker])
    expect(darkBuildMarkers({})).toEqual([])
    expect(darkBuildMarkerFileNames()).toEqual(['ORCA_SIDEBAR_INPUTS_MAIN'])
  })

  it('refuses ORCA_SIDEBAR_INPUTS at packaging time, and any output its dark build marked', async () => {
    const clean = await mkdtemp(join(tmpdir(), 'orca-build-switch-clean-'))
    scratch.push(clean)
    const [marker] = darkBuildMarkers({ ORCA_SIDEBAR_INPUTS: 'main' })
    const dark = await markedDir(marker)

    for (const assertRelease of [assertReleaseDesktopBuild, assertNotDarkBuild]) {
      expect(() => assertRelease([clean], {})).not.toThrow()
      expect(() => assertRelease([clean], { ORCA_SIDEBAR_INPUTS: 'main' })).toThrow(
        'ORCA_SIDEBAR_INPUTS=main'
      )
      expect(() => assertRelease([clean, dark], {})).toThrow(dark)
    }
  })

  it('lets a dark build carry its own phone page output, never one from a switch it has off', async () => {
    const [marker] = darkBuildMarkers({ ORCA_SIDEBAR_INPUTS: 'main' })
    const dark = await markedDir(marker)

    expect(() =>
      assertNoDarkOutputOfOffSwitches([dark], { ORCA_SIDEBAR_INPUTS: 'main' })
    ).not.toThrow()
    expect(() => assertNoDarkOutputOfOffSwitches([dark], { ORCA_LAYOUT_OWNER: 'main' })).toThrow(
      dark
    )
    expect(() => assertNoDarkOutputOfOffSwitches([dark], {})).toThrow(dark)
  })
})
