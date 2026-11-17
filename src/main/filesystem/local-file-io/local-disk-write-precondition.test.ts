import { link, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDiskBaselineSignature } from '../../../shared/file-write/disk-baseline-signature'
import type { RuntimeStore } from '../../runtime/construction/runtime-store-contract'
import { createLocalFilesystemProvider } from '../../providers/filesystem/local-provider'

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(await realpath(tmpdir()), 'orca-disk-write-precondition-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('local provider guarded write', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the write path reads nothing from the store; authorization is the injected stub.
  const store = {} as RuntimeStore
  const provider = () =>
    createLocalFilesystemProvider({
      requireStore: () => store,
      resolveAuthorizedPath: vi.fn(async (path: string) => path)
    })

  // Windows symlink creation requires elevated rights or Developer Mode.
  it.skipIf(process.platform === 'win32').each([
    ['a symlink', (target: string, alias: string) => symlink(target, alias)],
    ['a hardlink', (target: string, alias: string) => link(target, alias)]
  ])(
    'lets only one save win when two clients reach one file through %s',
    async (_label, makeAlias) => {
      const target = join(base, 'target.ts')
      const alias = join(base, 'alias.ts')
      await writeFile(target, 'original')
      await makeAlias(target, alias)
      const fromBaseline = { expectedSignature: getDiskBaselineSignature('original') }

      const results = await Promise.all([
        provider().writeFileWithDiskPrecondition(target, 'through target', fromBaseline),
        provider().writeFileWithDiskPrecondition(alias, 'through alias', fromBaseline)
      ])

      expect(results.filter((result) => result.ok)).toHaveLength(1)
    }
  )
})
