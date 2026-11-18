import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { listHermesProfiles } from './hermes-profiles'

const homes: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-hermes-profiles-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true })
  }
})

describe('listHermesProfiles', () => {
  it('lists only named profile directories and reports the sticky profile', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'profiles', 'work'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'alpha'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'notes.txt'), '')
    mkdirSync(join(home, 'profiles', 'Bad Name'))
    writeFileSync(join(home, 'active_profile'), 'work\n')

    await expect(listHermesProfiles(home)).resolves.toEqual({
      profiles: ['alpha', 'work'],
      activeProfile: 'work'
    })
  })

  it('falls back to the default profile when no profiles or sticky file exist', async () => {
    await expect(listHermesProfiles(makeHome())).resolves.toEqual({
      profiles: [],
      activeProfile: 'default'
    })
  })

  it('ignores an invalid sticky profile name', async () => {
    const home = makeHome()
    writeFileSync(join(home, 'active_profile'), '../escape')

    await expect(listHermesProfiles(home)).resolves.toMatchObject({ activeProfile: 'default' })
  })
})
