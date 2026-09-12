import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installLifetimeLockProcessFixture } from '../sqlite/lifetime-lock-process-fixture'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { parseOrcadLiveCutoverIntent } from './orcad-live-cutover-intent-store'

const addon = process.env.ORCA_TEST_PROFILE_LOCK_ADDON
const bun = process.env.ORCA_TEST_BUN_RUNTIME

describe.skipIf(!addon)('migration enrollment across actual profile-holder replacement', () => {
  const fixture = installLifetimeLockProcessFixture(
    'src/main/ssh/profile-lifetime-successor-probe-fixture.ts',
    [addon!],
    { state: 'acquired' }
  )
  const runtimes = [process.execPath, ...(bun ? [bun] : [])]
  for (const ownerRuntime of runtimes) {
    for (const successorRuntime of runtimes) {
      it(`retains enrollment after SIGKILL: ${ownerRuntime} -> ${successorRuntime}`, async () => {
        const profile = fixture.createProfile()
        const { manifest, bindings } = terminalLayoutAdmissionFixture('folder')
        const intent = parseOrcadLiveCutoverIntent({
          version: 2,
          phase: 'source-fenced',
          profileParticipationRequired: true,
          destinationEnvironmentId: 'destination',
          manifest,
          liveTerminalBindings: bindings,
          startedAt: manifest.createdAt,
          updatedAt: manifest.createdAt
        })
        const owner = await fixture.hold(ownerRuntime, profile)
        owner.child.stdin?.write(`migration-prepare ${JSON.stringify(intent)}\n`)
        expect(await owner.waitFor('migration-prepared')).toMatchObject({ mode: 'original' })
        const records = join(profile, 'orcad-live-profile-participation')
        const record = join(records, readdirSync(records)[0])
        const original = readFileSync(record)
        expect(await fixture.probe(successorRuntime, profile)).toEqual({ state: 'busy' })
        owner.child.kill('SIGKILL')
        await vi.waitFor(() =>
          expect(owner.child.exitCode !== null || owner.child.signalCode !== null).toBe(true)
        )
        const successor = await fixture.hold(successorRuntime, profile)
        successor.child.stdin?.write(`migration-successor ${JSON.stringify(intent)}\n`)
        expect(await successor.waitFor('migration-successor-retained')).toMatchObject({
          ordinaryRefused: true,
          mode: 'successor'
        })
        expect(readFileSync(record)).toEqual(original)
        successor.child.stdin?.write('check\n')
        await successor.waitFor('successor-current')
        expect(await fixture.probe(ownerRuntime, profile)).toEqual({ state: 'busy' })
        writeFileSync(record, '{}')
        successor.child.stdin?.write('check\n')
        await successor.waitFor('successor-lost')
      })
    }
  }
})
