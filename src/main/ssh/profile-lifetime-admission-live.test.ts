import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installLifetimeLockProcessFixture } from '../sqlite/lifetime-lock-process-fixture'

const addon = process.env.ORCA_TEST_PROFILE_LOCK_ADDON
const bun = process.env.ORCA_TEST_BUN_RUNTIME
describe.skipIf(!addon)('process-owned profile admission', () => {
  const fixture = installLifetimeLockProcessFixture(
    'src/main/ssh/profile-lifetime-admission-probe-fixture.ts',
    [addon!],
    { state: 'acquired' }
  )
  const runtimes = [process.execPath, ...(bun ? [bun] : [])]
  for (const owner of runtimes) {
    for (const contender of runtimes) {
      it(`retains ownership after work settles and flag clears: ${owner} / ${contender}`, async () => {
        const profile = fixture.createProfile()
        const { child, waitFor } = await fixture.hold(owner, profile)
        child.stdin?.write('admit\n')
        await waitFor('admitted')
        child.stdin?.write('disable\n')
        await waitFor('disabled')
        expect(await fixture.probe(contender, profile)).toEqual({ state: 'busy' })
        child.stdin?.write('exit\n')
        await vi.waitFor(() => expect(child.exitCode).toBe(0))
        expect(await fixture.probe(contender, profile)).toEqual({ state: 'acquired' })
      })
    }
    it.skipIf(process.platform === 'win32')(
      `blocks ledger work after lock replacement: ${owner}`,
      async () => {
        const profile = fixture.createProfile()
        const { child, waitFor } = await fixture.hold(owner, profile)
        const path = join(profile, 'profile-lifetime.lock')
        renameSync(path, `${path}.retained`)
        writeFileSync(path, '')
        child.stdin?.write('admit\n')
        await waitFor('refused')
        child.stdin?.write('disable\n')
        await waitFor('disabled')
        child.stdin?.write('rpc\n')
        expect(await waitFor('rpc-refused')).toMatchObject({ written: 0, code: 'CONNECTION_LOST' })
        expect(child.exitCode).toBeNull()
      }
    )
  }
})
