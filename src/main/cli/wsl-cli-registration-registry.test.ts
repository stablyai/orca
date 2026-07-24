import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getWslCliRegistrationCandidates,
  recordWslCliRegistrationObservations,
  recordWslCliRegistrationRemoved
} from './wsl-cli-registration-registry'

describe('WSL CLI registration registry', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'orca-wsl-cli-registry-'))
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('discovers each distro once while continuing to reconcile managed registrations', async () => {
    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu', 'Debian'])
    ).resolves.toEqual(['Ubuntu', 'Debian'])

    await recordWslCliRegistrationObservations(userDataPath, [
      { distro: 'Ubuntu', inspected: true, managed: false },
      { distro: 'Debian', inspected: true, managed: true }
    ])

    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['ubuntu', 'Debian', 'Fedora'])
    ).resolves.toEqual(['Debian', 'Fedora'])
    const state = JSON.parse(
      await readFile(join(userDataPath, 'wsl-cli-registrations.json'), 'utf8')
    ) as Record<string, unknown>
    expect(state).toMatchObject({
      schemaVersion: 2,
      registeredDistros: ['Debian'],
      inspectionTimes: {
        ubuntu: expect.any(Number),
        debian: expect.any(Number)
      }
    })
  })

  it('skips a registered distro already reconciled by this build against this launcher', async () => {
    const reconciled = { target: 'C:\\Orca\\resources\\bin\\orca.exe', appVersion: '1.4.138' }
    await recordWslCliRegistrationObservations(userDataPath, [
      { distro: 'Ubuntu', inspected: true, managed: true, reconciled }
    ])

    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu'], {
        currentTarget: reconciled.target,
        appVersion: reconciled.appVersion
      })
    ).resolves.toEqual([])
    // A launcher move or app update re-probes the registered distro.
    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu'], {
        currentTarget: 'D:\\Elsewhere\\orca.exe',
        appVersion: reconciled.appVersion
      })
    ).resolves.toEqual(['Ubuntu'])
    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu'], {
        currentTarget: reconciled.target,
        appVersion: '1.4.139'
      })
    ).resolves.toEqual(['Ubuntu'])
    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu'], {
        currentTarget: reconciled.target,
        appVersion: reconciled.appVersion,
        now: Date.now() + 365 * 24 * 60 * 60 * 1_000
      })
    ).resolves.toEqual([])
  })

  it('records unsupported inspections without changing registration ownership', async () => {
    await recordWslCliRegistrationObservations(userDataPath, [
      { distro: 'Ubuntu', inspected: true, managed: true }
    ])

    await recordWslCliRegistrationObservations(
      userDataPath,
      [{ distro: 'Ubuntu', inspected: true, managed: null, reconciled: null }],
      { now: 1_000 }
    )
    const state = JSON.parse(
      await readFile(join(userDataPath, 'wsl-cli-registrations.json'), 'utf8')
    ) as { registeredDistros: string[] }
    expect(state.registeredDistros).toEqual(['Ubuntu'])

    await recordWslCliRegistrationObservations(
      userDataPath,
      [{ distro: 'Fedora', inspected: true, managed: null }],
      { now: 1_000 }
    )
    // Unregistered unsupported distros gain the negative-inspection TTL.
    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Fedora'], {
        now: 2_000,
        negativeInspectionTtlMs: 10_000
      })
    ).resolves.toEqual([])
    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Fedora'], {
        now: 12_000,
        negativeInspectionTtlMs: 10_000
      })
    ).resolves.toEqual(['Fedora'])
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
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu', 'Debian'])
    ).resolves.toEqual(['Ubuntu', 'Debian'])
    await updates
    const state = JSON.parse(
      await readFile(join(userDataPath, 'wsl-cli-registrations.json'), 'utf8')
    ) as { registeredDistros: string[] }
    expect(state.registeredDistros).toEqual(['Ubuntu', 'Debian'])
  })

  it('rediscovers available distros when the registry is corrupt', async () => {
    await mkdir(userDataPath, { recursive: true })
    await writeFile(join(userDataPath, 'wsl-cli-registrations.json'), '{broken', 'utf8')

    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu', 'Debian'])
    ).resolves.toEqual(['Ubuntu', 'Debian'])
  })

  it('stops reconciling a registration removed through Settings', async () => {
    await recordWslCliRegistrationObservations(userDataPath, [
      { distro: 'Ubuntu', inspected: true, managed: true }
    ])
    await recordWslCliRegistrationRemoved(userDataPath, 'ubuntu')

    await expect(getWslCliRegistrationCandidates(userDataPath, ['Ubuntu'])).resolves.toEqual([])
  })

  it('periodically re-inspects a negative entry so restored distros are discovered', async () => {
    await recordWslCliRegistrationObservations(
      userDataPath,
      [{ distro: 'Ubuntu', inspected: true, managed: false }],
      { now: 1_000 }
    )

    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu'], {
        now: 1_001,
        negativeInspectionTtlMs: 10_000
      })
    ).resolves.toEqual([])
    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu'], {
        now: 11_001,
        negativeInspectionTtlMs: 10_000
      })
    ).resolves.toEqual(['Ubuntu'])
  })

  it('rediscovers negative entries after the system clock moves backward', async () => {
    await recordWslCliRegistrationObservations(
      userDataPath,
      [{ distro: 'Ubuntu', inspected: true, managed: false }],
      { now: 100_000 }
    )

    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu'], {
        now: 1_000,
        negativeInspectionTtlMs: 10_000
      })
    ).resolves.toEqual(['Ubuntu'])
  })

  it('safely rediscovers schema-v1 negative entries with no inspection time', async () => {
    await writeFile(
      join(userDataPath, 'wsl-cli-registrations.json'),
      JSON.stringify({
        schemaVersion: 1,
        registeredDistros: ['Debian'],
        inspectedDistros: ['Ubuntu', 'Debian']
      }),
      'utf8'
    )

    await expect(
      getWslCliRegistrationCandidates(userDataPath, ['Ubuntu', 'Debian'], {
        now: 1,
        negativeInspectionTtlMs: 1_000_000
      })
    ).resolves.toEqual(['Ubuntu', 'Debian'])
  })

  it('caps inspection bookkeeping while always keeping registered distros', async () => {
    const observations = Array.from({ length: 70 }, (_, index) => ({
      distro: `Distro${index}`,
      inspected: true,
      managed: false as const
    }))
    for (const [index, observation] of observations.entries()) {
      await recordWslCliRegistrationObservations(userDataPath, [observation], { now: index })
    }
    await recordWslCliRegistrationObservations(
      userDataPath,
      [{ distro: 'Managed Oldest', inspected: true, managed: true }],
      { now: 0 }
    )

    const state = JSON.parse(
      await readFile(join(userDataPath, 'wsl-cli-registrations.json'), 'utf8')
    ) as { registeredDistros: string[]; inspectionTimes: Record<string, number> }
    expect(state.registeredDistros).toEqual(['Managed Oldest'])
    expect(Object.keys(state.inspectionTimes).length).toBeLessThanOrEqual(65)
    expect(state.inspectionTimes['managed oldest']).toBe(0)
  })
})
