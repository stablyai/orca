import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getWslCliRegistrationCandidates,
  recordWslCliRegistrationObservations
} from './wsl-cli-registration-registry'

describe('WSL CLI registration registry', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'orca-wsl-cli-registry-'))
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('serializes concurrent registry updates without losing a distro', async () => {
    const updates = Promise.all([
      recordWslCliRegistrationObservations(userDataPath, [
        { distro: 'Ubuntu', inspected: true, managed: true }
      ]),
      recordWslCliRegistrationObservations(userDataPath, [
        { distro: 'Debian', inspected: true, managed: true }
      ])
    ])

    // Reads join the write queue, so startup cannot observe a half-updated registry.
    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu', 'Debian'], {
        inspectableDistros: ['Ubuntu', 'Debian']
      })
    ).resolves.toEqual(['Ubuntu', 'Debian'])
    await updates
    const state = JSON.parse(
      await readFile(join(userDataPath, 'wsl-cli-registrations.json'), 'utf8')
    ) as { registeredDistros: string[] }
    expect(state.registeredDistros).toEqual(['Ubuntu', 'Debian'])
  })
})
