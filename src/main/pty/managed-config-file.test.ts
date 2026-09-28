import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeManagedConfigFile } from './managed-config-file'

// A Windows directory junction is the platform's stand-in for a dir symlink and
// reports isSymbolicLink() AND isDirectory() from a single lstat.
const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'
const isWindows = process.platform === 'win32'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-managed-config-file-'))
  tempRoots.push(root)
  return root
}

describe('writeManagedConfigFile', () => {
  it('creates the file when the path is absent', async () => {
    const root = await makeRoot()
    const target = join(root, 'plugin.js')

    writeManagedConfigFile(target, 'orca')

    expect(readFileSync(target, 'utf8')).toBe('orca')
    expect(lstatSync(target).isFile()).toBe(true)
  })

  it('replaces a real file in place', async () => {
    const root = await makeRoot()
    const target = join(root, 'plugin.js')
    writeFileSync(target, 'stale')

    writeManagedConfigFile(target, 'orca')

    expect(readFileSync(target, 'utf8')).toBe('orca')
  })

  // A real directory at the managed filename is not something to silently
  // remove: unlink fails with a non-absence errno and the write must not run.
  it('refuses to write when a real directory occupies the path', async () => {
    const root = await makeRoot()
    const target = join(root, 'plugin.js')
    mkdirSync(target)

    expect(() => writeManagedConfigFile(target, 'orca')).toThrow()
    expect(lstatSync(target).isDirectory()).toBe(true)
  })

  it.skipIf(isWindows)('replaces a symlink to a file without touching the user bytes', async () => {
    const root = await makeRoot()
    const userFile = join(root, 'user-plugin.js')
    writeFileSync(userFile, 'user bytes')
    const target = join(root, 'plugin.js')
    symlinkSync(userFile, target, 'file')

    writeManagedConfigFile(target, 'orca')

    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('orca')
    expect(readFileSync(userFile, 'utf8')).toBe('user bytes')
  })

  it.skipIf(isWindows)(
    'replaces a dangling symlink instead of creating the file it points at',
    async () => {
      const root = await makeRoot()
      const missing = join(root, 'gone.js')
      const target = join(root, 'plugin.js')
      symlinkSync(missing, target, 'file')

      writeManagedConfigFile(target, 'orca')

      expect(lstatSync(target).isSymbolicLink()).toBe(false)
      expect(readFileSync(target, 'utf8')).toBe('orca')
      expect(existsSync(missing)).toBe(false)
    }
  )

  // On POSIX a dir symlink is unlinkable, so the managed file replaces it and
  // the linked directory keeps its contents. On Windows a junction needs rmdir,
  // so the unlink fails with a non-absence errno and the write is refused --
  // which is the safe direction, and is why the containing plugins directory is
  // guarded one level up by ensureOverlayDirectory instead.
  it('does not write into the target of a symlinked directory', async () => {
    const root = await makeRoot()
    const real = join(root, 'real-dir')
    mkdirSync(real)
    writeFileSync(join(real, 'user.js'), 'user bytes')
    const target = join(root, 'plugin.js')
    symlinkSync(real, target, directoryLinkType)

    if (isWindows) {
      expect(() => writeManagedConfigFile(target, 'orca')).toThrow()
    } else {
      writeManagedConfigFile(target, 'orca')
      expect(readFileSync(target, 'utf8')).toBe('orca')
      expect(lstatSync(target).isSymbolicLink()).toBe(false)
    }

    expect(readFileSync(join(real, 'user.js'), 'utf8')).toBe('user bytes')
    expect(existsSync(join(real, 'plugin.js'))).toBe(false)
  })

  it('applies exclusive create only when the caller asks for it', async () => {
    const root = await makeRoot()
    const exclusiveTarget = join(root, 'exclusive.js')
    const plainTarget = join(root, 'plain.js')

    // The unlink is what makes the path absent, so exclusive create still
    // succeeds against an existing file; the flag guards the post-unlink race.
    writeFileSync(exclusiveTarget, 'stale')
    writeManagedConfigFile(exclusiveTarget, 'orca', { exclusive: true })
    expect(readFileSync(exclusiveTarget, 'utf8')).toBe('orca')

    writeFileSync(plainTarget, 'stale')
    writeManagedConfigFile(plainTarget, 'orca')
    expect(readFileSync(plainTarget, 'utf8')).toBe('orca')
  })

  // The race the exclusive flag actually closes -- a link re-created between the
  // unlink and the write -- needs unlink fault injection and is covered at the
  // service level by hook-service-overlay.test.ts ('refuses a file link inserted
  // after the old plugin was removed'), so it is not re-faked here.
})
