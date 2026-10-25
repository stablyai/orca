import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browseSshDirectory } from './ssh-remote-directory-browse'

// Runs the generated remote command in a real local `sh`, standing in for the SSH exec channel.
function shellBackedManager(): Parameters<typeof browseSshDirectory>[0] {
  const exec = async (command: string): Promise<EventEmitter & { stderr: EventEmitter }> => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    const channel = Object.assign(new EventEmitter(), { stderr: new EventEmitter() })
    child.stdout.on('data', (data: Buffer) => channel.emit('data', data))
    child.stderr.on('data', (data: Buffer) => channel.stderr.emit('data', data))
    child.on('close', (code) => {
      channel.emit('exit', code)
      channel.emit('close', code)
    })
    return channel
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: browseSshDirectory only calls getConnection(id).exec(command).
  return { getConnection: () => ({ exec }) } as never
}

describe.skipIf(process.platform === 'win32')('browseSshDirectory over a POSIX shell', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-ssh-browse-symlink-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('marks a symlinked directory as a directory and keeps broken links and loops as files', async () => {
    await mkdir(join(root, 'real-dir'))
    await writeFile(join(root, 'real-file.txt'), 'x\n')
    await writeFile(join(root, '.hidden'), 'x\n')
    await writeFile(join(root, 'name with space'), 'x\n')
    await symlink(join(root, 'real-dir'), join(root, 'linked-dir'))
    await symlink(join(root, 'real-file.txt'), join(root, 'linked-file'))
    await symlink(join(root, 'missing-target'), join(root, 'broken-link'))
    await symlink(join(root, 'loop-b'), join(root, 'loop-a'))
    await symlink(join(root, 'loop-a'), join(root, 'loop-b'))

    const result = await browseSshDirectory(shellBackedManager(), 'ssh-1', root)

    expect(result.pathFlavor).toBe('posix')
    expect(result.entries).toEqual([
      { name: 'linked-dir', isDirectory: true },
      { name: 'real-dir', isDirectory: true },
      { name: '.hidden', isDirectory: false },
      { name: 'broken-link', isDirectory: false },
      { name: 'linked-file', isDirectory: false },
      { name: 'loop-a', isDirectory: false },
      { name: 'loop-b', isDirectory: false },
      { name: 'name with space', isDirectory: false },
      { name: 'real-file.txt', isDirectory: false }
    ])
  })

  it('navigates into a symlinked directory and lists an empty one as empty', async () => {
    await mkdir(join(root, 'real-dir', 'project'), { recursive: true })
    await mkdir(join(root, 'empty-real'))
    await symlink(join(root, 'real-dir'), join(root, 'linked-dir'))
    await symlink(join(root, 'empty-real'), join(root, 'linked-empty'))

    const linked = await browseSshDirectory(shellBackedManager(), 'ssh-1', join(root, 'linked-dir'))
    const empty = await browseSshDirectory(
      shellBackedManager(),
      'ssh-1',
      join(root, 'linked-empty')
    )

    expect(linked.entries).toEqual([{ name: 'project', isDirectory: true }])
    expect(empty.entries).toEqual([])
  })

  it('still fails instead of looking empty when the directory cannot be listed', async () => {
    await expect(
      browseSshDirectory(shellBackedManager(), 'ssh-1', join(root, 'missing'))
    ).rejects.toThrow()
    // Execute-only: `cd` and `pwd` succeed but `ls` cannot read it.
    const unreadable = join(root, 'unreadable')
    await mkdir(unreadable, { mode: 0o100 })
    try {
      if (process.getuid?.() !== 0) {
        await expect(
          browseSshDirectory(shellBackedManager(), 'ssh-1', unreadable)
        ).rejects.toThrow()
      }
    } finally {
      await chmod(unreadable, 0o700)
    }
  })
})
