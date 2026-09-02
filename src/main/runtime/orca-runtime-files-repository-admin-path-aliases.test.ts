import { existsSync } from 'node:fs'
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from './rpc/core'
import { REPOSITORY_ADMIN_PATH_DENIED_MESSAGE } from '../../shared/repository-admin-path'
import { REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE } from './repository-admin-path-authorization'
import type { RuntimeFileCommands } from './orca-runtime-files'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { setSshConnectionGeneration } from '../ssh/ssh-connection-generation'
import {
  buildRepo,
  dispatchFileMethod,
  expectRefused,
  fixture,
  terminalFileCommands
} from './repository-admin-path-test-harness'

vi.mock('../git/worktree', async () =>
  (await import('./repository-admin-path-worktree-mock')).worktreeModuleMock()
)

// Why: the relative spelling is not what the filesystem touches. A symlinked ancestor makes a path
// with no `.git` segment resolve straight into `.git`, so segment matching alone is not a guard.
describe.skipIf(process.platform === 'win32')(
  'files.* RPCs refuse a .git aliased through a symlinked ancestor',
  () => {
    beforeEach(async () => {
      await buildRepo()
      await symlink(join(fixture.repoPath, '.git'), join(fixture.repoPath, 'foo'), 'dir')
    })

    afterEach(async () => {
      await rm(fixture.repoPath, { recursive: true, force: true })
    })

    it('files.write refuses foo/config when foo is a symlink to .git', async () => {
      const response = await dispatchFileMethod('files.write', {
        relativePath: 'foo/config',
        content: '[core]\n\thooksPath = /tmp/evil\n'
      })

      expectRefused(response)
      expect(await readFile(join(fixture.repoPath, '.git', 'config'), 'utf-8')).toBe('[core]\n')
    })

    it('files.delete refuses foo/config when foo is a symlink to .git', async () => {
      const response = await dispatchFileMethod('files.delete', {
        relativePath: 'foo/config',
        recursive: false
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'config'))).toBe(true)
    })

    it('files.rename refuses foo/config as the source', async () => {
      const response = await dispatchFileMethod('files.rename', {
        oldRelativePath: 'foo/config',
        newRelativePath: 'stolen-config'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'config'))).toBe(true)
      expect(existsSync(join(fixture.repoPath, 'stolen-config'))).toBe(false)
    })

    it('files.rename refuses foo/hooks/pre-commit as the destination', async () => {
      const response = await dispatchFileMethod('files.rename', {
        oldRelativePath: 'tracked.txt',
        newRelativePath: 'foo/hooks/pre-commit'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'hooks'))).toBe(false)
    })

    it('files.copy refuses foo/hooks/pre-commit as the destination', async () => {
      const response = await dispatchFileMethod('files.copy', {
        sourceRelativePath: 'tracked.txt',
        destinationRelativePath: 'foo/hooks/pre-commit'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'hooks'))).toBe(false)
    })

    it('files.createDir refuses foo/hooks', async () => {
      const response = await dispatchFileMethod('files.createDir', {
        relativePath: 'foo/hooks'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'hooks'))).toBe(false)
    })

    it.each([
      ['files.writeBase64', { relativePath: 'foo/config', contentBase64: 'ZXZpbA==' }],
      [
        'files.writeBase64Chunk',
        { relativePath: 'foo/config', contentBase64: 'ZXZpbA==', append: true }
      ]
    ])('%s refuses a symlinked .git target', async (method, params) => {
      const response = await dispatchFileMethod(method, params)

      expectRefused(response)
      expect(await readFile(join(fixture.repoPath, '.git', 'config'), 'utf-8')).toBe('[core]\n')
    })

    it('files.createFile refuses foo/hooks/pre-commit', async () => {
      const response = await dispatchFileMethod('files.createFile', {
        relativePath: 'foo/hooks/pre-commit'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'hooks'))).toBe(false)
    })

    it('files.createDirNoClobber refuses foo/hooks', async () => {
      const response = await dispatchFileMethod('files.createDirNoClobber', {
        relativePath: 'foo/hooks'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'hooks'))).toBe(false)
    })

    it('files.copy refuses foo/config as the source', async () => {
      const response = await dispatchFileMethod('files.copy', {
        sourceRelativePath: 'foo/config',
        destinationRelativePath: 'stolen-config'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, 'stolen-config'))).toBe(false)
    })

    it('files.commitUpload refuses foo/config as the temp path', async () => {
      const response = await dispatchFileMethod('files.commitUpload', {
        tempRelativePath: 'foo/config',
        finalRelativePath: 'stolen-config'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'config'))).toBe(true)
      expect(existsSync(join(fixture.repoPath, 'stolen-config'))).toBe(false)
    })

    it('files.commitUpload refuses foo/hooks/pre-commit as the final path', async () => {
      const response = await dispatchFileMethod('files.commitUpload', {
        tempRelativePath: 'tracked.txt',
        finalRelativePath: 'foo/hooks/pre-commit'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'hooks'))).toBe(false)
    })

    // Why: deleting the link itself is legitimate and must keep working — only following it in is not.
    it('files.delete still removes the symlink itself, leaving .git intact', async () => {
      const response = await dispatchFileMethod('files.delete', {
        relativePath: 'foo',
        recursive: false
      })

      expect(response.ok).toBe(true)
      expect(existsSync(join(fixture.repoPath, 'foo'))).toBe(false)
      expect(existsSync(join(fixture.repoPath, '.git', 'HEAD'))).toBe(true)
    })
  }
)

// Why: `preserveSymlink` keeps the leaf on purpose so rename/delete act on the link itself, but
// copyFile reads and writes THROUGH the leaf, so for copy the link's target is the real object.
describe.skipIf(process.platform === 'win32')(
  'files.copy refuses a .git aliased through a leaf symlink',
  () => {
    beforeEach(async () => {
      await buildRepo()
      await mkdir(join(fixture.repoPath, '.git', 'hooks'), { recursive: true })
      await writeFile(
        join(fixture.repoPath, '.git', 'hooks', 'pre-commit'),
        '#!/bin/sh\nreal hook\n',
        'utf-8'
      )
      await symlink(
        join(fixture.repoPath, '.git', 'hooks', 'pre-commit'),
        join(fixture.repoPath, 'hook-link'),
        'file'
      )
      await symlink(
        join(fixture.repoPath, '.git', 'config'),
        join(fixture.repoPath, 'config-link'),
        'file'
      )
    })

    afterEach(async () => {
      await rm(fixture.repoPath, { recursive: true, force: true })
    })

    it('refuses a leaf symlink to a hook as the source', async () => {
      const response = await dispatchFileMethod('files.copy', {
        sourceRelativePath: 'hook-link',
        destinationRelativePath: 'stolen'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, 'stolen'))).toBe(false)
    })

    it('refuses a leaf symlink to .git/config as the source', async () => {
      const response = await dispatchFileMethod('files.copy', {
        sourceRelativePath: 'config-link',
        destinationRelativePath: 'stolen-config'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, 'stolen-config'))).toBe(false)
    })

    // Why: realpath ENOENTs on a DANGLING symlink exactly as it does on a path that is simply
    // absent, but writeFile FOLLOWS the link and creates its target — so the link's own name is the
    // wrong thing to classify. This one created .git/hooks/post-commit from nothing.
    it('refuses a write through a dangling symlink into .git', async () => {
      await symlink(
        join(fixture.repoPath, '.git', 'hooks', 'post-commit'),
        join(fixture.repoPath, 'dangling'),
        'file'
      )

      const response = await dispatchFileMethod('files.write', {
        relativePath: 'dangling',
        content: '#!/bin/sh\nEVIL\n'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, '.git', 'hooks', 'post-commit'))).toBe(false)
    })

    it('still writes through a dangling symlink that stays in the working tree', async () => {
      await symlink(
        join(fixture.repoPath, 'not-yet.txt'),
        join(fixture.repoPath, 'pending'),
        'file'
      )

      const response = await dispatchFileMethod('files.write', {
        relativePath: 'pending',
        content: 'ok\n'
      })

      expect(response.ok).toBe(true)
      expect(await readFile(join(fixture.repoPath, 'not-yet.txt'), 'utf-8')).toBe('ok\n')
    })

    // Why also the destination: COPYFILE_EXCL happens to block this today, and it is the only thing
    // that does. Classifying it too keeps the guard from depending on that flag staying put.
    it('refuses a leaf symlink into .git as the destination', async () => {
      const response = await dispatchFileMethod('files.copy', {
        sourceRelativePath: 'tracked.txt',
        destinationRelativePath: 'hook-link'
      })

      expectRefused(response)
      expect(await readFile(join(fixture.repoPath, '.git', 'hooks', 'pre-commit'), 'utf-8')).toBe(
        '#!/bin/sh\nreal hook\n'
      )
    })

    // Why: a symlink loop makes realpath fail with ELOOP, not ENOENT — the leaf exists but what it
    // points at is unknowable, so the copy is refused rather than attempted.
    it('fails closed when the leaf cannot be canonicalized', async () => {
      await symlink(join(fixture.repoPath, 'loop-b'), join(fixture.repoPath, 'loop-a'), 'file')
      await symlink(join(fixture.repoPath, 'loop-a'), join(fixture.repoPath, 'loop-b'), 'file')

      const response = await dispatchFileMethod('files.copy', {
        sourceRelativePath: 'loop-a',
        destinationRelativePath: 'looped-copy'
      })

      expectRefused(response)
      expect(existsSync(join(fixture.repoPath, 'looped-copy'))).toBe(false)
    })

    it('still copies through a leaf symlink that stays in the working tree', async () => {
      await symlink(
        join(fixture.repoPath, 'tracked.txt'),
        join(fixture.repoPath, 'plain-link'),
        'file'
      )

      const response = await dispatchFileMethod('files.copy', {
        sourceRelativePath: 'plain-link',
        destinationRelativePath: 'copied.txt'
      })

      expect(response.ok).toBe(true)
      expect(await readFile(join(fixture.repoPath, 'copied.txt'), 'utf-8')).toBe(
        'working tree content\n'
      )
    })

    // Why: rename and delete act on the directory entry, never on what the link points at.
    it('still renames and deletes the link itself, leaving the hook intact', async () => {
      const renamed = await dispatchFileMethod('files.rename', {
        oldRelativePath: 'hook-link',
        newRelativePath: 'hook-link-moved'
      })
      const deleted = await dispatchFileMethod('files.delete', {
        relativePath: 'hook-link-moved',
        recursive: false
      })

      expect(renamed.ok).toBe(true)
      expect(deleted.ok).toBe(true)
      expect(await readFile(join(fixture.repoPath, '.git', 'hooks', 'pre-commit'), 'utf-8')).toBe(
        '#!/bin/sh\nreal hook\n'
      )
    })
  }
)

// Why: the SSH branch returns before the local gate, so the canonical-path check never runs there.
// The relative-path guard at the RPC boundary is the only thing covering it.
describe('files.* RPCs refuse repository admin paths on the SSH branch', () => {
  beforeEach(async () => {
    await buildRepo()
    fixture.connectionId = 'conn-1'
  })

  afterEach(async () => {
    fixture.connectionId = undefined
    await rm(fixture.repoPath, { recursive: true, force: true })
  })

  it.each(['files.delete', 'files.write', 'files.createDir'])(
    '%s refuses .git before reaching the SSH provider',
    async (method) => {
      const response = await dispatchFileMethod(
        method,
        method === 'files.write'
          ? { relativePath: '.git/config', content: 'evil' }
          : { relativePath: '.git/config', recursive: false }
      )

      // Without the guard this reaches getSshFilesystemProvider and reports a dropped connection.
      expectRefused(response)
    }
  )

  it('files.rename refuses a .git destination before reaching the SSH provider', async () => {
    const response = await dispatchFileMethod('files.rename', {
      oldRelativePath: 'tracked.txt',
      newRelativePath: '.git/hooks/pre-commit'
    })

    expectRefused(response)
  })
})

// Why: the flavour comes from the target worktree's path, not this process. Hardcoding the
// strictest flavour refused a legitimately named `.git.` directory on POSIX.
describe('repository admin path flavour follows the target host', () => {
  afterEach(async () => {
    fixture.connectionId = undefined
    fixture.pathOverride = undefined
    await rm(fixture.repoPath, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'still deletes a POSIX directory legitimately named ".git."',
    async () => {
      await buildRepo()
      await mkdir(join(fixture.repoPath, '.git.'), { recursive: true })
      await writeFile(join(fixture.repoPath, '.git.', 'note.txt'), 'ordinary\n', 'utf-8')

      const response = await dispatchFileMethod('files.delete', {
        relativePath: '.git.',
        recursive: true
      })

      expect(response.ok).toBe(true)
      expect(existsSync(join(fixture.repoPath, '.git.'))).toBe(false)
      expect(existsSync(join(fixture.repoPath, '.git', 'HEAD'))).toBe(true)
    }
  )

  it('refuses ".git." when the target host path is Windows-shaped', async () => {
    await buildRepo()
    fixture.connectionId = 'conn-1'
    fixture.pathOverride = 'C:\\remote\\repo'

    const response = await dispatchFileMethod('files.delete', {
      relativePath: '.git.',
      recursive: true
    })

    expectRefused(response)
  })

  it('does not refuse ".git." when the target host path is POSIX', async () => {
    await buildRepo()
    fixture.connectionId = 'conn-1'
    fixture.pathOverride = '/remote/repo'

    const response = await dispatchFileMethod('files.delete', {
      relativePath: '.git.',
      recursive: true
    })

    // Reaches the SSH provider instead of the guard; the refusal message is what matters here.
    expect(response.ok).toBe(false)
    expect((response as { error: { message: string } }).error.message).not.toBe(
      REPOSITORY_ADMIN_PATH_DENIED_MESSAGE
    )
  })
})

// Why: a hard link has no target to resolve — every name for the inode is equally real and realpath
// returns whichever was given. Link count is the only portable signal that `.git` shares the bytes.
describe.skipIf(process.platform === 'win32')('hard-linked aliases into .git', () => {
  beforeEach(async () => {
    await buildRepo()
    await mkdir(join(fixture.repoPath, '.git', 'hooks'), { recursive: true })
    await writeFile(
      join(fixture.repoPath, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nreal\n',
      'utf-8'
    )
    await link(
      join(fixture.repoPath, '.git', 'hooks', 'pre-commit'),
      join(fixture.repoPath, 'hook-hard')
    )
    await link(join(fixture.repoPath, '.git', 'config'), join(fixture.repoPath, 'cfg-hard'))
  })

  afterEach(async () => {
    await rm(fixture.repoPath, { recursive: true, force: true })
  })

  function expectHardLinkRefused(response: RpcResponse): void {
    expect(response.ok).toBe(false)
    expect((response as { error: { message: string } }).error.message).toBe(
      REPOSITORY_ADMIN_HARD_LINK_DENIED_MESSAGE
    )
  }

  it('files.write refuses to truncate through a hard link', async () => {
    const response = await dispatchFileMethod('files.write', {
      relativePath: 'hook-hard',
      content: 'EVIL\n'
    })

    expectHardLinkRefused(response)
    expect(await readFile(join(fixture.repoPath, '.git', 'hooks', 'pre-commit'), 'utf-8')).toBe(
      '#!/bin/sh\nreal\n'
    )
  })

  it('files.copy refuses to read through a hard link', async () => {
    const response = await dispatchFileMethod('files.copy', {
      sourceRelativePath: 'cfg-hard',
      destinationRelativePath: 'stolen'
    })

    expectHardLinkRefused(response)
    expect(existsSync(join(fixture.repoPath, 'stolen'))).toBe(false)
  })

  it('files.writeBase64Chunk refuses to append through a hard link', async () => {
    const response = await dispatchFileMethod('files.writeBase64Chunk', {
      relativePath: 'hook-hard',
      contentBase64: 'ZXZpbA==',
      append: true
    })

    expectHardLinkRefused(response)
    expect(await readFile(join(fixture.repoPath, '.git', 'hooks', 'pre-commit'), 'utf-8')).toBe(
      '#!/bin/sh\nreal\n'
    )
  })

  it('files.commitUpload refuses to read through a hard-linked temp path', async () => {
    const response = await dispatchFileMethod('files.commitUpload', {
      tempRelativePath: 'cfg-hard',
      finalRelativePath: 'stolen'
    })

    expectHardLinkRefused(response)
    expect(existsSync(join(fixture.repoPath, 'stolen'))).toBe(false)
  })

  // Why: unlinking one name of an inode is not destruction, and renaming moves the entry only.
  it('still renames and deletes a hard link, leaving the linked file intact', async () => {
    const renamed = await dispatchFileMethod('files.rename', {
      oldRelativePath: 'hook-hard',
      newRelativePath: 'hook-hard-moved'
    })
    const deleted = await dispatchFileMethod('files.delete', {
      relativePath: 'hook-hard-moved',
      recursive: false
    })

    expect(renamed.ok).toBe(true)
    expect(deleted.ok).toBe(true)
    expect(await readFile(join(fixture.repoPath, '.git', 'hooks', 'pre-commit'), 'utf-8')).toBe(
      '#!/bin/sh\nreal\n'
    )
  })

  it('still writes and copies ordinary single-named files', async () => {
    const written = await dispatchFileMethod('files.write', {
      relativePath: 'tracked.txt',
      content: 'edited\n'
    })
    const copied = await dispatchFileMethod('files.copy', {
      sourceRelativePath: 'tracked.txt',
      destinationRelativePath: 'copy.txt'
    })

    expect(written.ok).toBe(true)
    expect(copied.ok).toBe(true)
    expect(await readFile(join(fixture.repoPath, 'copy.txt'), 'utf-8')).toBe('edited\n')
  })
})

// Why: `files.writeTerminalArtifact` is grant-mediated on an ABSOLUTE path and never passes through
// the worktree-relative funnel. Grants are confined to the terminal-artifact roots (tmpdir, /tmp),
// but any repository under one — a scratch clone, a CI checkout — has its `.git` inside that root,
// and a path outside the current worktree skips the in-worktree branch on every platform.
describe.skipIf(process.platform === 'win32')('files.writeTerminalArtifact', () => {
  // A SECOND repository under the temp root. Deliberately not the worktree under test and reached
  // by its plain mkdtemp spelling, so the construction needs no symlinked prefix to work.
  let scratchRepo = ''

  beforeEach(async () => {
    await buildRepo()
    scratchRepo = await mkdtemp(join(tmpdir(), 'orca-admin-path-scratch-'))
    await mkdir(join(scratchRepo, '.git', 'hooks'), { recursive: true })
    await writeFile(join(scratchRepo, '.git', 'config'), '[core]\n', 'utf-8')
    await writeFile(join(scratchRepo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nreal\n', 'utf-8')
    await writeFile(join(scratchRepo, 'notes.txt'), 'artifact\n', 'utf-8')
  })

  afterEach(async () => {
    await rm(fixture.repoPath, { recursive: true, force: true })
    await rm(scratchRepo, { recursive: true, force: true })
  })

  // Grants live on the RuntimeFileCommands instance that minted them, so mint and write on one.
  async function grantFor(
    commands: RuntimeFileCommands,
    relativeParts: string[]
  ): Promise<{ grantId: string; path: string }> {
    const absolutePath = join(scratchRepo, ...relativeParts)
    const resolution = await commands.resolveTerminalPath(
      'sel',
      absolutePath,
      null,
      'client-1',
      'term-1'
    )
    const grantId = (resolution as { openTarget?: { grantId?: string } }).openTarget?.grantId
    expect(grantId).toBeTruthy()
    return { grantId: grantId as string, path: resolution.absolutePath as string }
  }

  it('refuses to write a granted .git/config', async () => {
    const commands = terminalFileCommands()
    const granted = await grantFor(commands, ['.git', 'config'])

    await expect(
      commands.writeTerminalArtifactFile('sel', granted.grantId, granted.path, 'EVIL\n', 'client-1')
    ).rejects.toThrow(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
    expect(await readFile(join(scratchRepo, '.git', 'config'), 'utf-8')).toBe('[core]\n')
  })

  it('refuses to write a granted .git hook', async () => {
    const commands = terminalFileCommands()
    const granted = await grantFor(commands, ['.git', 'hooks', 'pre-commit'])

    await expect(
      commands.writeTerminalArtifactFile('sel', granted.grantId, granted.path, 'EVIL\n', 'client-1')
    ).rejects.toThrow(REPOSITORY_ADMIN_PATH_DENIED_MESSAGE)
    expect(await readFile(join(scratchRepo, '.git', 'hooks', 'pre-commit'), 'utf-8')).toBe(
      '#!/bin/sh\nreal\n'
    )
  })

  it('still writes a granted ordinary artifact', async () => {
    const commands = terminalFileCommands()
    const granted = await grantFor(commands, ['notes.txt'])

    await expect(
      commands.writeTerminalArtifactFile(
        'sel',
        granted.grantId,
        granted.path,
        'edited\n',
        'client-1'
      )
    ).resolves.toEqual({ ok: true })
    expect(await readFile(join(scratchRepo, 'notes.txt'), 'utf-8')).toBe('edited\n')
  })
})

// Why: the SSH branch returns before any local authorization, so the relative spelling is all the
// client sees — and a guest-side symlink makes it lie. Classification happens on the execution
// host's canonical path, via the relay's fs.realpath.
describe('SSH lane refuses aliased .git paths', () => {
  const dispatched: string[] = []
  let realpathImpl: (remotePath: string) => Promise<string>

  beforeEach(async () => {
    await buildRepo()
    fixture.connectionId = 'conn-1'
    fixture.pathOverride = '/remote/repo'
    dispatched.length = 0
    realpathImpl = async (remotePath) => remotePath
    setSshConnectionGeneration('conn-1', 7)
    fixture.sshGeneration = 7
    registerSshFilesystemProvider('conn-1', {
      realpath: (remotePath: string) => realpathImpl(remotePath),
      writeFile: async (p: string) => void dispatched.push(`writeFile:${p}`),
      writeFileBase64: async (p: string) => void dispatched.push(`writeFileBase64:${p}`),
      writeFileBase64Chunk: async (p: string) => void dispatched.push(`chunk:${p}`),
      createFile: async (p: string) => void dispatched.push(`createFile:${p}`),
      createDir: async (p: string) => void dispatched.push(`createDir:${p}`),
      createDirNoClobber: async (p: string) => void dispatched.push(`createDirNoClobber:${p}`),
      deletePath: async (p: string) => void dispatched.push(`deletePath:${p}`),
      renameNoClobber: async (a: string, b: string) => void dispatched.push(`rename:${a}->${b}`),
      copy: async (a: string, b: string) => void dispatched.push(`copy:${a}->${b}`)
    } as never)
  })

  afterEach(async () => {
    unregisterSshFilesystemProvider('conn-1')
    fixture.connectionId = undefined
    fixture.pathOverride = undefined
    fixture.sshGeneration = undefined
    await rm(fixture.repoPath, { recursive: true, force: true })
  })

  /** `safe -> .git` on the remote host. */
  function aliasSafeToGit(): void {
    realpathImpl = async (remotePath) =>
      remotePath.replace(/^\/remote\/repo\/safe(?=\/|$)/, '/remote/repo/.git')
  }

  it('refuses a write through a remote symlinked ancestor', async () => {
    aliasSafeToGit()

    const response = await dispatchFileMethod('files.write', {
      relativePath: 'safe/config',
      content: 'EVIL\n'
    })

    expectRefused(response)
    expect(dispatched).toEqual([])
  })

  it('refuses a delete through a remote symlinked ancestor', async () => {
    aliasSafeToGit()

    const response = await dispatchFileMethod('files.delete', {
      relativePath: 'safe/config',
      recursive: false
    })

    expectRefused(response)
    expect(dispatched).toEqual([])
  })

  it('refuses a copy whose remote source is a leaf symlink into .git', async () => {
    realpathImpl = async (remotePath) =>
      remotePath === '/remote/repo/hook-link' ? '/remote/repo/.git/hooks/pre-commit' : remotePath

    const response = await dispatchFileMethod('files.copy', {
      sourceRelativePath: 'hook-link',
      destinationRelativePath: 'stolen'
    })

    expectRefused(response)
    expect(dispatched).toEqual([])
  })

  it('refuses a rename whose remote destination resolves into .git', async () => {
    aliasSafeToGit()

    const response = await dispatchFileMethod('files.rename', {
      oldRelativePath: 'tracked.txt',
      newRelativePath: 'safe/hooks'
    })

    expectRefused(response)
    expect(dispatched).toEqual([])
  })

  // Why: over-blocking ordinary remote editing would be worse than the hole.
  it('still dispatches ordinary remote mutations', async () => {
    const written = await dispatchFileMethod('files.write', {
      relativePath: 'src/app.ts',
      content: 'ok\n'
    })
    const deleted = await dispatchFileMethod('files.delete', {
      relativePath: 'src/old.ts',
      recursive: false
    })

    expect(written.ok).toBe(true)
    expect(deleted.ok).toBe(true)
    expect(dispatched).toEqual([
      'writeFile:/remote/repo/src/app.ts',
      'deletePath:/remote/repo/src/old.ts'
    ])
  })

  // Why: deleting the link itself is legitimate; only following it in is not.
  it('still deletes a remote symlink itself', async () => {
    aliasSafeToGit()

    const response = await dispatchFileMethod('files.delete', {
      relativePath: 'safe',
      recursive: false
    })

    expect(response.ok).toBe(true)
    expect(dispatched).toEqual(['deletePath:/remote/repo/safe'])
  })

  // Why: an older provider may not implement realpath at all. Calling a missing method throws
  // synchronously, which no .catch() around the call would absorb, so it is checked up front.
  it('stays permissive when the provider has no realpath at all', async () => {
    unregisterSshFilesystemProvider('conn-1')
    registerSshFilesystemProvider('conn-1', {
      writeFile: async (p: string) => void dispatched.push(`writeFile:${p}`)
    } as never)

    const response = await dispatchFileMethod('files.write', {
      relativePath: 'safe/config',
      content: 'ok\n'
    })

    expect(response.ok).toBe(true)
    expect(dispatched).toEqual(['writeFile:/remote/repo/safe/config'])
  })

  // Why: fs.realpath has been on the relay since 2026-07-26, but a host predating it must keep
  // working. Permissive by design — this leaves the hole open there rather than bricking editing.
  it('stays permissive when the remote host cannot canonicalize', async () => {
    realpathImpl = async () => {
      throw new Error('unknown method fs.realpath')
    }

    const response = await dispatchFileMethod('files.write', {
      relativePath: 'safe/config',
      content: 'ok\n'
    })

    expect(response.ok).toBe(true)
    expect(dispatched).toEqual(['writeFile:/remote/repo/safe/config'])
  })
})
