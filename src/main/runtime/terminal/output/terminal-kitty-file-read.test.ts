import { afterEach, describe, expect, it, vi } from 'vitest'
import { link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { readTerminalKittyFile } from './terminal-kitty-file-read'
import { TERMINAL_KITTY_FILE_MAX_BYTES } from '../../../../shared/terminal/images/terminal-kitty-file'
import * as kittyTemporaryRoots from './terminal-kitty-temporary-roots'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-kitty-file-'))
  roots.push(root)
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  const path = join(workspacePath, 'image')
  await writeFile(path, 'prefix-IMAGE-suffix')
  return { root, path, owner: { workspacePath, wslDistro: null } }
}

describe('PTY-owned Kitty file reads', () => {
  it('reads binary bytes and an exact window, leaving the producer file intact', async () => {
    const { path, owner } = await fixture()
    expect(await readTerminalKittyFile({ path, offset: 7, length: 5 }, owner)).toEqual({
      base64: Buffer.from('IMAGE').toString('base64')
    })
    expect(await readTerminalKittyFile({ path }, owner)).toEqual({
      base64: Buffer.from('prefix-IMAGE-suffix').toString('base64')
    })
  })

  it('restricts a floating terminal to temporary roots without granting a workspace', async () => {
    const { root, path } = await fixture()
    const temporary = join(root, 'allowed-temp')
    await mkdir(temporary)
    vi.spyOn(kittyTemporaryRoots, 'kittyTemporaryRoots').mockResolvedValue([
      await realpath(temporary)
    ])
    const image = join(temporary, 'image')
    await writeFile(image, 'IMAGE')
    const owner = { workspacePath: null, wslDistro: null }
    expect(await readTerminalKittyFile({ path: image }, owner)).toEqual({ base64: 'SU1BR0U=' })
    await expect(readTerminalKittyFile({ path }, owner)).rejects.toThrow('outside this terminal')
  })

  it('rejects directories and multiply-linked files', async () => {
    const { path, root, owner } = await fixture()
    await expect(readTerminalKittyFile({ path: owner.workspacePath }, owner)).rejects.toThrow(
      'regular file'
    )
    await link(path, join(root, 'hard-link'))
    await expect(readTerminalKittyFile({ path }, owner)).rejects.toThrow('hard links')
  })

  it.skipIf(process.platform === 'win32')(
    'does not read a temporary symlink pointing outside the allowed roots',
    async () => {
      const { root, owner } = await fixture()
      const path = join(root, 'escape')
      await symlink(process.execPath, path, process.platform === 'win32' ? 'file' : undefined)
      await expect(readTerminalKittyFile({ path }, owner)).rejects.toThrow('outside this terminal')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO without waiting for a writer',
    async () => {
      const { root, owner } = await fixture()
      const path = join(root, 'fifo')
      const result = await runProcess({ program: 'mkfifo', args: [path], timeoutMs: 2000 })
      expect(result.code).toBe(0)
      await expect(readTerminalKittyFile({ path }, owner)).rejects.toThrow('regular file')
    }
  )

  it('rejects oversize, truncated extents, and cancelled reads', async () => {
    const { path, owner } = await fixture()
    await expect(readTerminalKittyFile({ path, length: 20 }, owner)).rejects.toThrow('smaller')
    await writeFile(path, Buffer.alloc(TERMINAL_KITTY_FILE_MAX_BYTES + 1))
    await expect(readTerminalKittyFile({ path }, owner)).rejects.toThrow('File too large')
    const controller = new AbortController()
    controller.abort(new Error('cancelled file'))
    await expect(readTerminalKittyFile({ path }, owner, controller.signal)).rejects.toThrow(
      'cancelled file'
    )
  })
})
