// src/relay/ssh-outbound-filesystem-provider.test.ts
// TASK-AG-EVM-007: readDirViaHiddenTarget / readFileViaHiddenTarget — SFTP
// reads over a hidden target's dialed OutboundSshSession, looked up from
// the real hiddenTargetRegistry singleton (agent-ephemeral-vm-handler.ts).
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OutboundSshSession } from './ssh-outbound-client'

function makeStats(kind: 'file' | 'directory' | 'symlink'): {
  isDirectory: () => boolean
  isFile: () => boolean
  isSymbolicLink: () => boolean
} {
  return {
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink'
  }
}

function makeFakeSession(sftp: {
  readdir: ReturnType<typeof vi.fn>
  readFile: ReturnType<typeof vi.fn>
}): OutboundSshSession {
  return {
    client: {
      sftp: (cb: (err: Error | undefined, sftp: unknown) => void) => cb(undefined, sftp)
    } as unknown as OutboundSshSession['client'],
    close: vi.fn()
  }
}

beforeEach(async () => {
  const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
  hiddenTargetRegistry.clear()
})

describe('validateReadDirViaHiddenTargetParams / validateReadFileViaHiddenTargetParams', () => {
  it('returns validated params for readDir', async () => {
    const { validateReadDirViaHiddenTargetParams } =
      await import('./ssh-outbound-filesystem-provider')
    expect(
      validateReadDirViaHiddenTargetParams({ hiddenTargetId: 'rt-1', path: '/srv/app' })
    ).toEqual({ hiddenTargetId: 'rt-1', path: '/srv/app' })
  })

  it('throws when hiddenTargetId is missing (readDir)', async () => {
    const { validateReadDirViaHiddenTargetParams } =
      await import('./ssh-outbound-filesystem-provider')
    expect(() => validateReadDirViaHiddenTargetParams({ path: '/srv/app' })).toThrow(
      /hiddenTargetId/
    )
  })

  it('throws when path is missing (readFile)', async () => {
    const { validateReadFileViaHiddenTargetParams } =
      await import('./ssh-outbound-filesystem-provider')
    expect(() => validateReadFileViaHiddenTargetParams({ hiddenTargetId: 'rt-1' })).toThrow(/path/)
  })
})

describe('readDirViaHiddenTarget', () => {
  it('reads a directory listing through the session dialed for that hiddenTargetId', async () => {
    const readdir = vi.fn((_path: string, cb: (err: undefined, list: unknown[]) => void) => {
      cb(undefined, [
        { filename: '.', attrs: makeStats('directory') },
        { filename: '..', attrs: makeStats('directory') },
        { filename: 'src', attrs: makeStats('directory') },
        { filename: 'index.ts', attrs: makeStats('file') },
        { filename: 'link', attrs: makeStats('symlink') }
      ])
    })
    const session = makeFakeSession({ readdir, readFile: vi.fn() })
    const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
    hiddenTargetRegistry.set('rt-1', session)

    const { readDirViaHiddenTarget } = await import('./ssh-outbound-filesystem-provider')
    const result = await readDirViaHiddenTarget({ hiddenTargetId: 'rt-1', path: '/srv/app' })

    expect(readdir).toHaveBeenCalledWith('/srv/app', expect.any(Function))
    expect(result.entries).toEqual([
      { name: 'src', type: 'directory' },
      { name: 'index.ts', type: 'file' },
      { name: 'link', type: 'symlink' }
    ])
  })

  it('throws a clear error when hiddenTargetId is not registered (never dialed)', async () => {
    const { readDirViaHiddenTarget } = await import('./ssh-outbound-filesystem-provider')
    await expect(
      readDirViaHiddenTarget({ hiddenTargetId: 'no-such-target', path: '/srv/app' })
    ).rejects.toThrow(/No hidden target session/)
  })

  it('propagates an sftp readdir error without hanging', async () => {
    const readdir = vi.fn((_path: string, cb: (err: Error, list?: unknown[]) => void) => {
      cb(new Error('Permission denied'))
    })
    const session = makeFakeSession({ readdir, readFile: vi.fn() })
    const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
    hiddenTargetRegistry.set('rt-err', session)

    const { readDirViaHiddenTarget } = await import('./ssh-outbound-filesystem-provider')
    await expect(
      readDirViaHiddenTarget({ hiddenTargetId: 'rt-err', path: '/root' })
    ).rejects.toThrow('Permission denied')
  })
})

describe('readFileViaHiddenTarget', () => {
  it('reads file content through SFTP and returns it base64-encoded', async () => {
    const readFile = vi.fn((_path: string, cb: (err: undefined, data: Buffer) => void) => {
      cb(undefined, Buffer.from('hello world'))
    })
    const session = makeFakeSession({ readdir: vi.fn(), readFile })
    const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
    hiddenTargetRegistry.set('rt-2', session)

    const { readFileViaHiddenTarget } = await import('./ssh-outbound-filesystem-provider')
    const result = await readFileViaHiddenTarget({ hiddenTargetId: 'rt-2', path: '/srv/app/a.txt' })

    expect(readFile).toHaveBeenCalledWith('/srv/app/a.txt', expect.any(Function))
    expect(result).toEqual({
      content: Buffer.from('hello world').toString('base64'),
      encoding: 'base64'
    })
  })

  it('throws a clear error, does not hang, when the session was closed (agent restart mid-session)', async () => {
    const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
    hiddenTargetRegistry.delete('rt-gone')

    const { readFileViaHiddenTarget } = await import('./ssh-outbound-filesystem-provider')
    await expect(
      readFileViaHiddenTarget({ hiddenTargetId: 'rt-gone', path: '/srv/app/a.txt' })
    ).rejects.toThrow(/No hidden target session/)
  })
})
