import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { assertNotDarkBuild, darkBuildDefines, darkBuildMarkers, turnedOnDarkBuildDefines } =
  createRequire(import.meta.url)('../dark-build-switches.cjs')

const scratch = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dark build switches', () => {
  it.each(['ORCA_LAYOUT_OWNER', 'ORCA_SIDEBAR_INPUTS'])(
    'compiles the dark path in only when %s=main asks',
    (variable) => {
      expect(darkBuildDefines({ [variable]: 'main' })[variable]).toBe('"main"')
      expect(darkBuildDefines({ [variable]: 'window' })[variable]).toBe('"window"')
      expect(darkBuildDefines({})[variable]).toBe('"window"')
      expect(turnedOnDarkBuildDefines({ [variable]: 'main' })).toEqual({ [variable]: '"main"' })
      expect(turnedOnDarkBuildDefines({})).toEqual({})
    }
  )

  it('keeps the layout-owner marker name packaging already refuses', () => {
    expect(darkBuildMarkers({ ORCA_LAYOUT_OWNER: 'main' })).toEqual([
      {
        fileName: 'ORCA_LAYOUT_OWNER_MAIN',
        text: 'Built with ORCA_LAYOUT_OWNER=main, for dark testing only.\n'
      }
    ])
    expect(darkBuildMarkers({})).toEqual([])
  })

  it.each(['ORCA_LAYOUT_OWNER', 'ORCA_SIDEBAR_INPUTS'])(
    'refuses %s at packaging time, and any output its dark build marked',
    async (variable) => {
      const clean = await mkdtemp(join(tmpdir(), 'orca-dark-build-clean-'))
      const dark = await mkdtemp(join(tmpdir(), 'orca-dark-build-dark-'))
      scratch.push(clean, dark)
      const [marker] = darkBuildMarkers({ [variable]: 'main' })
      await writeFile(join(dark, marker.fileName), marker.text)

      expect(() => assertNotDarkBuild([clean], {})).not.toThrow()
      expect(() => assertNotDarkBuild([clean], { [variable]: 'main' })).toThrow(`${variable}=main`)
      expect(() => assertNotDarkBuild([clean, dark], {})).toThrow(dark)
    }
  )
})
