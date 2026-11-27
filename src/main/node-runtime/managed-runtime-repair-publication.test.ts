import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { installRuntimeRelease } from './managed-runtime-release-install'
import {
  reclaimRuntimeReleases,
  writeRuntimeReleaseReceipt,
  type ManagedRuntimePin
} from './managed-runtime-release'

const failure = vi.hoisted(() => ({ target: '', occupy: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === failure.target && basename(String(args[0])) === 'release') {
        if (failure.occupy) {
          await actual.mkdir(failure.target)
          await actual.writeFile(join(failure.target, 'winner'), 'concurrent release')
        }
        throw Object.assign(new Error('publication denied'), { code: 'EACCES' })
      }
      return actual.rename(...args)
    }
  }
})

const pinFor = (contents: string): ManagedRuntimePin => {
  const sha256 = createHash('sha256').update(contents).digest('hex')
  return {
    version: '1.2.3',
    url: 'https://downloads.invalid/server',
    archiveSha256: sha256,
    archiveBytes: Buffer.byteLength(contents),
    format: 'file',
    members: [{ path: 'server', sha256, bytes: Buffer.byteLength(contents) }]
  }
}

it.each([false, true])(
  'keeps the previous release after failed publication (occupied: %s)',
  async (occupied) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-repair-publication-'))
    const folder = join(root, '1.2.3')
    try {
      await mkdir(folder)
      await writeFile(join(folder, 'server'), 'previous release')
      await chmod(join(folder, 'server'), 0o755)
      await writeRuntimeReleaseReceipt(folder, pinFor('previous release'))
      failure.target = folder
      failure.occupy = occupied
      const install = () =>
        installRuntimeRelease({
          agent: 'server-agent',
          runtime: { label: 'Server' },
          root,
          pin: pinFor('replacement release'),
          fetcher: async () => new Response('replacement release'),
          automaticFreeSpaceMarginBytes: 0,
          signal: new AbortController().signal,
          publish: () => {},
          commit: () => {}
        })
      await expect(install()).rejects.toThrow(
        occupied ? 'the previous copy is kept at' : 'publication denied'
      )
      if (occupied) {
        expect(await readFile(join(folder, 'winner'), 'utf8')).toBe('concurrent release')
        const staging = (await readdir(root)).find((name) => name.startsWith('.download-'))!
        expect(await reclaimRuntimeReleases(root, ['1.2.3'])).toEqual([staging])
        expect(await readFile(join(root, staging, 'damaged', 'server'), 'utf8')).toBe(
          'previous release'
        )
        await writeFile(join(folder, 'server'), 'replacement release')
        await chmod(join(folder, 'server'), 0o755)
        await writeRuntimeReleaseReceipt(folder, pinFor('replacement release'))
        expect(await reclaimRuntimeReleases(root, ['1.2.3'])).toEqual([])
        expect(await readdir(root)).toEqual(['1.2.3'])
      } else {
        expect(await readFile(join(folder, 'server'), 'utf8')).toBe('previous release')
        expect(await readdir(root)).toEqual(['1.2.3'])
        failure.target = ''
        await install()
        expect(await readFile(join(folder, 'server'), 'utf8')).toBe('replacement release')
        expect(await readdir(root)).toEqual(['1.2.3'])
      }
    } finally {
      failure.target = ''
      failure.occupy = false
      await rm(root, { recursive: true, force: true })
    }
  }
)
