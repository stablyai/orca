import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installLifetimeLockProcessFixture } from '../sqlite/lifetime-lock-process-fixture'

const addon = process.env.ORCA_TEST_PROFILE_LOCK_ADDON
const bun = process.env.ORCA_TEST_BUN_RUNTIME
describe.skipIf(!addon)('retained native successor authority', () => {
  const fixture = installLifetimeLockProcessFixture(
    'src/main/ssh/profile-lifetime-successor-probe-fixture.ts',
    [addon!],
    { state: 'acquired' }
  )
  const runtimes = [process.execPath, ...(bun ? [bun] : [])]
  for (const ownerRuntime of runtimes) {
    for (const successorRuntime of runtimes) {
      it.each(['exit', 'SIGKILL'] as const)(
        `excludes the former holder after %s: ${ownerRuntime} / ${successorRuntime}`,
        async (stop) => {
          const profile = fixture.createProfile()
          const owner = await fixture.hold(ownerRuntime, profile)
          const historical = (await owner.waitFor('acquired')).participation
          expect(await fixture.probe(successorRuntime, profile)).toEqual({ state: 'busy' })
          if (stop === 'exit') {
            owner.child.stdin?.write('exit\n')
          } else {
            owner.child.kill('SIGKILL')
          }
          await vi.waitFor(() =>
            expect(owner.child.exitCode !== null || owner.child.signalCode !== null).toBe(true)
          )
          const successor = await fixture.hold(successorRuntime, profile)
          successor.child.stdin?.write(`successor ${JSON.stringify(historical)}\n`)
          await successor.waitFor('successor-retained')
          successor.child.stdin?.write('check\n')
          await successor.waitFor('successor-current')
          expect(await fixture.probe(ownerRuntime, profile)).toEqual({ state: 'busy' })
          if (process.platform !== 'win32') {
            renameSync(join(profile, 'profile-lifetime.lock'), join(profile, 'old.lock'))
            writeFileSync(join(profile, 'profile-lifetime.lock'), '')
            successor.child.stdin?.write('check\n')
            await successor.waitFor('successor-lost')
          }
        }
      )
    }
    it.skipIf(process.platform === 'win32')(
      `refuses a replacement inode while the old holder remains running: ${ownerRuntime}`,
      async () => {
        const profile = fixture.createProfile()
        const owner = await fixture.hold(ownerRuntime, profile)
        const historical = (await owner.waitFor('acquired')).participation
        renameSync(join(profile, 'profile-lifetime.lock'), join(profile, 'old.lock'))
        writeFileSync(join(profile, 'profile-lifetime.lock'), '')
        const successor = await fixture.hold(ownerRuntime, profile)
        successor.child.stdin?.write(`successor ${JSON.stringify(historical)}\n`)
        expect(await successor.waitFor('successor-refused')).toMatchObject({
          error: expect.stringContaining('identity_changed')
        })
        expect(owner.child.exitCode).toBeNull()
        expect(owner.child.signalCode).toBeNull()
      }
    )
  }
})
