import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverProviderOwnership } from './provider-ownership-journal'

// Why POSIX-only: the journal only accepts a directory whose permission bits exclude group and
// other, and Windows synthesizes `mode` (a normal directory reports 0o777), so no staging there
// produces an accepted directory. The journal never runs on Windows anyway: supervised provider
// spawns are POSIX-only, which leaves the boot id null and the journal off there.
describe.skipIf(process.platform === 'win32')('provider ownership recovery', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function ownershipDirectory(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-ownership-'))
    roots.push(root)
    return join(root, 'provider-ownership')
  }

  it('recovers an empty ownership directory', async () => {
    // An empty journal is a successful scan, so this pins the privacy gate accepting a normal
    // user-owned directory instead of the recovery path failing on it.
    await expect(recoverProviderOwnership(await ownershipDirectory(), 'boot-test')).resolves.toBe(
      undefined
    )
  })

  it('refuses a directory that other users can read', async () => {
    const directory = await ownershipDirectory()
    await mkdir(directory, { recursive: true })
    await chmod(directory, 0o755)
    await expect(recoverProviderOwnership(directory, 'boot-test')).rejects.toThrow('not private')
  })
})
