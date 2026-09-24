// The child script the probe runs is a minified copy of enumerateDirectoryOnce's errno mapping,
// inlined because the child can load nothing from the app bundle. Every other test mocks the
// spawn away, so this is the only place the script itself is executed.

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { probeFolderAccessForFreshDaemon } from './daemon-folder-access-probe'

// chmod cannot lock root out of a directory, and does not withhold reads on Windows.
const CAN_MAKE_A_DIRECTORY_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-folder-access-probe-'))
})

afterAll(async () => {
  await chmod(join(root, 'unreadable'), 0o700).catch(() => {})
  await rm(root, { recursive: true, force: true })
})

describe('the probe child, run against real paths', () => {
  it('reads a directory it can list as ok', async () => {
    await expect(probeFolderAccessForFreshDaemon(root)).resolves.toBe('ok')
  })

  it('reads a path that is not there as missing', async () => {
    await expect(probeFolderAccessForFreshDaemon(join(root, 'absent'))).resolves.toBe('missing')
  })

  it('reads a file as missing rather than as a denial', async () => {
    const file = join(root, 'file.txt')
    await writeFile(file, 'contents')

    await expect(probeFolderAccessForFreshDaemon(file)).resolves.toBe('missing')
  })

  it.runIf(CAN_MAKE_A_DIRECTORY_UNREADABLE)(
    'reads a directory it may not open as denied',
    async () => {
      const unreadable = join(root, 'unreadable')
      await mkdir(unreadable)
      await chmod(unreadable, 0o000)

      await expect(probeFolderAccessForFreshDaemon(unreadable)).resolves.toBe('denied')
    }
  )
})
