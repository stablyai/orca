import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { assertNoDarkOutputOfOffSwitches, assertNotDarkBuild, darkBuildMarkers } = createRequire(
  import.meta.url
)('../../../dark-build-switches.cjs')

const scratch = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dark build switches', () => {
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

  it.each([
    ['ORCA_LAYOUT_OWNER', 'ORCA_SIDEBAR_INPUTS'],
    ['ORCA_SIDEBAR_INPUTS', 'ORCA_LAYOUT_OWNER']
  ])('lets a dark build carry its own %s output, never one of %s', async (own, other) => {
    const dark = await mkdtemp(join(tmpdir(), 'orca-dark-build-own-'))
    scratch.push(dark)
    const [marker] = darkBuildMarkers({ [own]: 'main' })
    await writeFile(join(dark, marker.fileName), marker.text)

    expect(() => assertNoDarkOutputOfOffSwitches([dark], { [own]: 'main' })).not.toThrow()
    expect(() => assertNoDarkOutputOfOffSwitches([dark], { [other]: 'main' })).toThrow(dark)
    expect(() => assertNoDarkOutputOfOffSwitches([dark], {})).toThrow(dark)
  })
})
