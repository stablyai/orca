import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyPrivateTree,
  hardlinkTree,
  makeTreeReadOnly,
  makeTreeReadOnlyAsync,
  makeTreeWritable,
  shareTree,
  shareTreeAsync
} from './space-sharing-copy.mjs'

const roots: string[] = []

describe('asynchronous immutable sharing', () => {
  it('preserves read-only source and relative symlinks on the execution host', async () => {
    const { root, source } = makeTree()
    await makeTreeReadOnlyAsync(source)
    const destination = path.join(root, 'async-copy')
    await shareTreeAsync(source, destination)
    expect(readFileSync(path.join(destination, 'nested', 'file'), 'utf8')).toBe('contents')
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
    expect(statSync(path.join(destination, 'nested', 'file')).mode & 0o222).toBe(0)
  })

  it('removes partial copies before its Linux hardlink fallback', async () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'async-copy')
    const reflink = async (_source: string, target: string) => {
      mkdirSync(target)
      writeFileSync(path.join(target, 'partial'), 'partial')
      throw new Error('unsupported reflink')
    }
    expect(await shareTreeAsync(source, destination, { platform: 'linux', reflink })).toBe(
      'hardlink'
    )
    expect(existsSync(path.join(destination, 'partial'))).toBe(false)
    expect(statSync(path.join(destination, 'nested', 'file')).ino).toBe(
      statSync(path.join(source, 'nested', 'file')).ino
    )
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
  })

  it('waits for the asynchronous sharing mechanism to finish', async () => {
    const { root, source } = makeTree()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let completed = false
    const sharing = shareTreeAsync(source, path.join(root, 'async-copy'), {
      platform: 'darwin',
      clone: async () => {
        await pending
      }
    }).then(() => {
      completed = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(completed).toBe(false)
    finish()
    await sharing
    expect(completed).toBe(true)
  })
})

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

function makeTree(): { root: string; source: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-share-'))
  roots.push(root)
  const source = path.join(root, 'source')
  mkdirSync(path.join(source, 'nested'), { recursive: true })
  writeFileSync(path.join(source, 'nested', 'file'), 'contents')
  symlinkSync(path.join('nested', 'file'), path.join(source, 'relative-link'))
  return { root, source }
}

describe('shareTree', () => {
  it('keeps relative symlinks unresolved on whatever this host supports', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'shared')
    expect(shareTree(source, destination)).toBeTruthy()
    expect(readFileSync(path.join(destination, 'nested', 'file'), 'utf8')).toBe('contents')
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
  })

  it('falls from reflink to hardlink on Linux, where ext4 has no reflinks', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'shared')
    const reflink = vi.fn(() => {
      throw new Error('failed to clone: Invalid cross-device link')
    })
    expect(shareTree(source, destination, { platform: 'linux', reflink })).toBe('hardlink')
    expect(reflink).toHaveBeenCalledOnce()
    expect(statSync(path.join(destination, 'nested', 'file')).ino).toBe(
      statSync(path.join(source, 'nested', 'file')).ino
    )
  })

  it('hardlinks on Windows, the only mechanism NTFS offers', () => {
    const { root, source } = makeTree()
    expect(shareTree(source, path.join(root, 'shared'), { platform: 'win32' })).toBe('hardlink')
  })

  it('clears a part-way tree before trying the next mechanism', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'shared')
    const reflink = (_source: string, target: string) => {
      mkdirSync(target, { recursive: true })
      writeFileSync(path.join(target, 'half-written'), 'partial')
      throw new Error('reflink failed midway')
    }
    expect(shareTree(source, destination, { platform: 'linux', reflink })).toBe('hardlink')
    expect(existsSync(path.join(destination, 'half-written'))).toBe(false)
  })

  it('throws rather than silently paying for a second full copy', () => {
    const { root, source } = makeTree()
    expect(() => shareTree(source, path.join(root, 'shared'), { platform: 'freebsd' })).toThrow(
      /Could not share storage/
    )
  })

  it('uses strict native-copy arguments and handles their failures', async () => {
    const nativeCopy = vi.fn(() => {
      throw new Error('native storage sharing unavailable')
    })
    vi.doMock('node:child_process', () => ({ execFileSync: nativeCopy }))
    vi.resetModules()
    try {
      const { shareTree: shareWithNativeCopy } = await import('./space-sharing-copy.mjs')
      const { root, source } = makeTree()
      const cloneDestination = path.join(root, 'clone')
      expect(() => shareWithNativeCopy(source, cloneDestination, { platform: 'darwin' })).toThrow(
        /Could not share storage/
      )
      expect(existsSync(cloneDestination)).toBe(false)
      expect(nativeCopy).toHaveBeenNthCalledWith(
        1,
        '/bin/cp',
        ['-c', '-R', '-P', source, cloneDestination],
        { stdio: 'ignore' }
      )

      const reflinkDestination = path.join(root, 'reflink')
      expect(shareWithNativeCopy(source, reflinkDestination, { platform: 'linux' })).toBe(
        'hardlink'
      )
      expect(nativeCopy).toHaveBeenNthCalledWith(
        2,
        'cp',
        ['--reflink=always', '-a', source, reflinkDestination],
        { stdio: 'ignore' }
      )
      expect(statSync(path.join(reflinkDestination, 'nested', 'file')).ino).toBe(
        statSync(path.join(source, 'nested', 'file')).ino
      )
      expect(readFileSync(path.join(reflinkDestination, 'nested', 'file'), 'utf8')).toBe('contents')
      expect(readlinkSync(path.join(reflinkDestination, 'relative-link'))).toBe(
        path.join('nested', 'file')
      )
    } finally {
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })
})

describe('hardlinkTree', () => {
  it('shares inodes for files but recreates symlinks as their own entries', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'linked')
    hardlinkTree(source, destination)
    expect(statSync(path.join(destination, 'nested', 'file')).ino).toBe(
      statSync(path.join(source, 'nested', 'file')).ino
    )
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
  })

  it('propagates a write through the shared inode, which is why callers must protect it', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'linked')
    hardlinkTree(source, destination)
    writeFileSync(path.join(destination, 'nested', 'file'), 'mutated')
    expect(readFileSync(path.join(source, 'nested', 'file'), 'utf8')).toBe('mutated')
  })
})

describe('makeTreeReadOnly', () => {
  it('drops write permission on files while leaving directories traversable and unlinkable', () => {
    const { source } = makeTree()
    makeTreeReadOnly(source)
    expect(statSync(path.join(source, 'nested', 'file')).mode & 0o222).toBe(0)
    // Assert rename/remove behavior, not mode bits: Windows chmod maps only read-only attribute and directories never report 0755.
    expect(() => rmSync(path.join(source, 'nested'), { recursive: true })).not.toThrow()
  })

  it('turns an extract-over-dist write into an error instead of silent shared corruption', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'linked')
    hardlinkTree(source, destination)
    makeTreeReadOnly(destination)
    expect(() => writeFileSync(path.join(destination, 'nested', 'file'), 'mutated')).toThrow()
    expect(readFileSync(path.join(source, 'nested', 'file'), 'utf8')).toBe('contents')
  })

  it.runIf(process.platform !== 'win32')('preserves setuid, which chrome-sandbox needs', () => {
    const { source } = makeTree()
    const sandbox = path.join(source, 'chrome-sandbox')
    writeFileSync(sandbox, 'binary')
    chmodSync(sandbox, 0o4755)
    makeTreeReadOnly(source)
    expect(statSync(sandbox).mode & 0o4000).toBe(0o4000)
    expect(statSync(sandbox).mode & 0o222).toBe(0)
  })

  it.runIf(process.platform !== 'win32')(
    'keeps the executable bit, which Electron needs to launch',
    () => {
      const { source } = makeTree()
      const executable = path.join(source, 'electron')
      writeFileSync(executable, 'binary', { mode: 0o755 })
      chmodSync(executable, 0o755)
      makeTreeReadOnly(source)
      // ext4 reports 0555; Windows read-only attribute does not prevent hardlinked executable from running on NTFS.
      expect(statSync(executable).mode & 0o111).toBe(0o111)
    }
  )
})

describe('makeTreeWritable', () => {
  it.runIf(process.platform !== 'win32')('undoes makeTreeReadOnly for the owner', () => {
    const { source } = makeTree()
    makeTreeReadOnly(source)
    makeTreeWritable(source)
    const file = path.join(source, 'nested', 'file')
    expect(statSync(file).mode & 0o200).toBe(0o200)
    expect(() => writeFileSync(file, 'mutated')).not.toThrow()
  })

  it.runIf(process.platform !== 'win32')('adds no write permission beyond the owner', () => {
    const { source } = makeTree()
    const executable = path.join(source, 'electron')
    writeFileSync(executable, 'binary')
    chmodSync(executable, 0o555)
    makeTreeWritable(source)
    expect(statSync(executable).mode & 0o777).toBe(0o755)
  })
})

describe('copyPrivateTree', () => {
  it.runIf(process.platform !== 'win32')(
    'hands back a tree the caller can patch, even from a write-protected source',
    () => {
      const { root, source } = makeTree()
      const destination = path.join(root, 'private')
      makeTreeReadOnly(source)
      copyPrivateTree(source, destination)
      // Private copy inherits shared-cache read-only modes; restore owner write or dev Info.plist patch fails.
      expect(() => writeFileSync(path.join(destination, 'nested', 'file'), 'patched')).not.toThrow()
      expect(readFileSync(path.join(source, 'nested', 'file'), 'utf8')).toBe('contents')
    }
  )

  it('never hardlinks, because the caller patches what it gets back', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'private')
    const hardlink = vi.fn()
    const result = copyPrivateTree(source, destination, { platform: 'linux', hardlink })
    expect(hardlink).not.toHaveBeenCalled()
    expect(statSync(path.join(destination, 'nested', 'file')).ino).not.toBe(
      statSync(path.join(source, 'nested', 'file')).ino
    )
    expect(result.mechanism === 'reflink' || result.mechanism === null).toBe(true)
  })

  it('copies bytes on a platform with no private mechanism at all', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'private')
    const hardlink = vi.fn()
    expect(copyPrivateTree(source, destination, { platform: 'win32', hardlink })).toEqual({
      mechanism: null,
      copyError: null
    })
    expect(hardlink).not.toHaveBeenCalled()
    expect(readFileSync(path.join(destination, 'nested', 'file'), 'utf8')).toBe('contents')
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
  })

  it('falls back to a byte copy when the private mechanism fails', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'private')
    const clone = () => {
      throw new Error('clonefile unsupported')
    }
    const result = copyPrivateTree(source, destination, { platform: 'darwin', clone })
    expect(result.mechanism).toBeNull()
    expect(result.copyError).toBeInstanceOf(Error)
    expect(readFileSync(path.join(destination, 'nested', 'file'), 'utf8')).toBe('contents')
  })
})
