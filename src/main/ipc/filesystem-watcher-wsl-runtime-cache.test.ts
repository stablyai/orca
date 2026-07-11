import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { copyFileMock, mkdirMock, readFileMock, rmMock, spawnMock } = vi.hoisted(() => ({
  copyFileMock: vi.fn(),
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  rmMock: vi.fn(),
  spawnMock: vi.fn()
}))
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: spawnMock }))
vi.mock('node:fs/promises', () => ({
  copyFile: copyFileMock,
  mkdir: mkdirMock,
  readFile: readFileMock,
  rm: rmMock
}))

import {
  ensureWslWatcherRuntime,
  resetWslWatcherRuntimeForTest,
  WslWatcherCompatibilityError
} from './filesystem-watcher-wsl-runtime'

class FakeInstaller extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()

  respond(chunks: Buffer[], code = 0, stderr = ''): void {
    this.stdin.once('finish', () => {
      for (const chunk of chunks) {
        this.stdout.write(chunk)
      }
      if (stderr) {
        this.stderr.write(stderr)
      }
      this.emit('close', code, null)
    })
  }
}

function createDeferredCopy(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

afterEach(() => {
  resetWslWatcherRuntimeForTest()
  spawnMock.mockReset()
})

beforeEach(() => {
  copyFileMock.mockReset().mockResolvedValue(undefined)
  mkdirMock.mockReset().mockResolvedValue(undefined)
  rmMock.mockReset().mockResolvedValue(undefined)
  readFileMock.mockReset().mockResolvedValue(
    JSON.stringify({
      protocol: 1,
      installLayout: 1,
      nodeVersion: '24.15.0',
      bundleVersion: 'a'.repeat(20)
    })
  )
})

describe('managed WSL runtime integrity probes', () => {
  it('re-probes after every resolved call while sharing only in-flight work', async () => {
    const first = new FakeInstaller()
    const second = new FakeInstaller()
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second)
    const output = Buffer.from('ready\n/home/me/node\n/home/me/host.js\n')
    first.respond([output])
    await expect(ensureWslWatcherRuntime('Ubuntu')).resolves.toMatchObject({
      nodePath: '/home/me/node'
    })
    second.respond([output])
    await expect(ensureWslWatcherRuntime('Ubuntu')).resolves.toMatchObject({
      hostPath: '/home/me/host.js'
    })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('decodes installer UTF-8 split inside a Unicode path', async () => {
    const child = new FakeInstaller()
    spawnMock.mockReturnValueOnce(child)
    const output = Buffer.from('ready\n/home/æµ‹è¯•/node\n/home/æµ‹è¯•/host.js\n')
    const split = output.indexOf(Buffer.from('æµ‹')) + 1
    child.respond([output.subarray(0, split), output.subarray(split)])
    await expect(ensureWslWatcherRuntime('Ubuntu')).resolves.toEqual({
      nodePath: '/home/æµ‹è¯•/node',
      hostPath: '/home/æµ‹è¯•/host.js'
    })
  })

  it('surfaces compatibility exit codes as structured permanent errors', async () => {
    const child = new FakeInstaller()
    spawnMock.mockReturnValueOnce(child)
    child.respond([], 73, 'managed WSL watcher requires glibc >= 2.28')
    await expect(ensureWslWatcherRuntime('Legacy')).rejects.toBeInstanceOf(
      WslWatcherCompatibilityError
    )
  })

  it.each(['stdout', 'stderr'] as const)(
    'contains installer %s stream errors and rejects only once',
    async (stream) => {
      const child = new FakeInstaller()
      spawnMock.mockReturnValueOnce(child)
      const pending = ensureWslWatcherRuntime('Broken')
      const failure = new Error(`${stream} failed`)
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())

      expect(() => child[stream].emit('error', failure)).not.toThrow()
      child.emit('close', 0, null)
      expect(() => child[stream].emit('error', new Error('late stream error'))).not.toThrow()

      await expect(pending).rejects.toBe(failure)
      expect(child.kill).toHaveBeenCalledOnce()
    }
  )

  it('cancels shared installation only after its last owner cancels', async () => {
    const child = new FakeInstaller()
    spawnMock.mockReturnValueOnce(child)
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = ensureWslWatcherRuntime('Shared', firstAbort.signal)
    const second = ensureWslWatcherRuntime('Shared', secondAbort.signal)

    firstAbort.abort()
    await expect(first).rejects.toThrow('cancelled')
    expect(child.kill).not.toHaveBeenCalled()

    secondAbort.abort()
    await expect(second).rejects.toThrow('cancelled')
    expect(child.kill).toHaveBeenCalledOnce()
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it('falls back to the legacy WSL UNC provider and cleans both provider paths', async () => {
    const probe = new FakeInstaller()
    const install = new FakeInstaller()
    spawnMock.mockReturnValueOnce(probe).mockReturnValueOnce(install)
    mkdirMock.mockImplementation(async (target: string) => {
      if (target.startsWith('\\\\wsl.localhost\\')) {
        throw Object.assign(new Error('provider unavailable'), { code: 'ENOENT' })
      }
    })
    probe.respond([Buffer.from('install\nx64\n/home/me\n')])
    install.respond([Buffer.from('ready\n/home/me/node\n/home/me/host.js\n')])

    await expect(ensureWslWatcherRuntime('Ubuntu')).resolves.toEqual({
      nodePath: '/home/me/node',
      hostPath: '/home/me/host.js'
    })

    expect(mkdirMock.mock.calls[0]?.[0]).toMatch(/^\\\\wsl\.localhost\\Ubuntu\\/)
    expect(mkdirMock.mock.calls[1]?.[0]).toMatch(/^\\\\wsl\$\\Ubuntu\\/)
    expect(rmMock.mock.calls.some(([target]) => String(target).startsWith('\\\\wsl$\\'))).toBe(true)
  })

  it('settles started UNC copies before cleanup and legacy provider fallback', async () => {
    const probe = new FakeInstaller()
    const install = new FakeInstaller()
    const pendingCopies = [createDeferredCopy(), createDeferredCopy(), createDeferredCopy()]
    const providerFailure = Object.assign(new Error('modern provider copy failed'), {
      code: 'ENOENT'
    })
    spawnMock.mockReturnValueOnce(probe).mockReturnValueOnce(install)
    copyFileMock.mockImplementation((_source: string, target: string) => {
      if (!target.startsWith('\\\\wsl.localhost\\')) {
        return Promise.resolve()
      }
      const modernCopyIndex = copyFileMock.mock.calls.length - 1
      return modernCopyIndex === 0
        ? Promise.reject(providerFailure)
        : pendingCopies[modernCopyIndex - 1]?.promise
    })
    probe.respond([Buffer.from('install\nx64\n/home/me\n')])
    install.respond([Buffer.from('ready\n/home/me/node\n/home/me/host.js\n')])

    const pendingInstall = ensureWslWatcherRuntime('Ubuntu')
    await vi.waitFor(() => expect(copyFileMock.mock.calls.length).toBeGreaterThanOrEqual(4))
    await Promise.resolve()

    expect(copyFileMock).toHaveBeenCalledTimes(4)
    expect(rmMock).not.toHaveBeenCalled()
    expect(mkdirMock).toHaveBeenCalledTimes(1)

    for (const pendingCopy of pendingCopies) {
      pendingCopy.resolve()
    }
    await expect(pendingInstall).resolves.toEqual({
      nodePath: '/home/me/node',
      hostPath: '/home/me/host.js'
    })

    expect(mkdirMock.mock.calls[1]?.[0]).toMatch(/^\\\\wsl\$\\Ubuntu\\/)
    expect(
      rmMock.mock.calls.some(([target]) => String(target).startsWith('\\\\wsl.localhost\\'))
    ).toBe(true)
    expect(rmMock.mock.calls.some(([target]) => String(target).startsWith('\\\\wsl$\\'))).toBe(true)
  })

  it('keeps staged transfer data for a retained owner and cleans it after final cancellation', async () => {
    const probe = new FakeInstaller()
    const install = new FakeInstaller()
    spawnMock.mockReturnValueOnce(probe).mockReturnValueOnce(install)
    probe.respond([Buffer.from('install\nx64\n/home/me\n')])
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = ensureWslWatcherRuntime('Ubuntu', firstAbort.signal)
    const second = ensureWslWatcherRuntime('Ubuntu', secondAbort.signal)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))

    firstAbort.abort()
    await expect(first).rejects.toThrow('cancelled')
    expect(install.kill).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalled()

    secondAbort.abort()
    await expect(second).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(install.kill).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(rmMock).toHaveBeenCalled())
  })
})
