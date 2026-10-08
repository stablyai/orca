import { describe, it, expect, vi } from 'vitest'
import { ensureWslPinnedRuntime, type WslRuntimeCommand } from './wsl-pinned-runtime'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
const mocks = vi.hoisted(() => ({
  download: vi.fn(
    async (_target: string, _root: string, _options: { signal?: AbortSignal }) =>
      'C:/cache/pinned.tar.gz'
  )
}))
vi.mock('../ssh/pinned-runtime-materializer', () => ({
  materializeNodeRuntimeArchive: mocks.download
}))
function runner(present = false, libc = 'glibc 2.31', promoted = 'ORCA_NODE_RUNTIME_READY') {
  return vi.fn<WslRuntimeCommand>(async (spec) => {
    if (spec.program === 'uname') {
      return 'x86_64'
    }
    if (spec.program === 'wslpath') {
      return '/mnt/c/cache/pinned.tar.gz'
    }
    if (spec.script?.startsWith('getconf')) {
      return libc
    }
    if (spec.script?.startsWith('printf')) {
      return '/home/fake'
    }
    if (spec.script?.includes('ORCA_NODE_RUNTIME_EXTRACT_FAILED')) {
      return promoted
    }
    return present ? 'ORCA_NODE_RUNTIME_READY' : 'ORCA_NODE_RUNTIME_MISSING'
  })
}
describe('shared WSL pinned runtime', () => {
  it('uses the existing materializer and verifies the pinned guest executable without a host Node prerequisite', async () => {
    mocks.download.mockClear()
    const run = runner()
    const result = await ensureWslPinnedRuntime(run, '/fake/cache', new AbortController().signal)
    expect(mocks.download).toHaveBeenCalledWith('linux-x64-glibc', '/fake/cache', expect.anything())
    expect(result).toContain(NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256)
    const install = run.mock.calls.find(([spec]) =>
      spec.script?.includes('ORCA_NODE_RUNTIME_EXTRACT_FAILED')
    )?.[0]
    expect(install?.args).toEqual(['/mnt/c/cache/pinned.tar.gz'])
    expect(install?.script).toContain('--version')
    expect(run.mock.calls.some(([spec]) => spec.program === 'node')).toBe(false)
  })
  it('reuses a verified old guest cache without downloading or replacing it', async () => {
    mocks.download.mockClear()
    const run = runner(true)
    await ensureWslPinnedRuntime(run, '/fake/cache', new AbortController().signal)
    expect(mocks.download).not.toHaveBeenCalled()
    expect(
      run.mock.calls.some(([spec]) => spec.script?.includes('ORCA_NODE_RUNTIME_EXTRACT_FAILED'))
    ).toBe(false)
    expect(run.mock.calls.some(([spec]) => spec.script?.includes('sha256sum'))).toBe(true)
  })
  it('refuses download and guest verification failures without a system-node fallback', async () => {
    mocks.download.mockRejectedValueOnce(new Error('offline'))
    await expect(
      ensureWslPinnedRuntime(runner(), '/fake/cache', new AbortController().signal)
    ).rejects.toThrow('offline')
    const run = runner()
    run.mockImplementation(async (spec) => {
      if (spec.program === 'uname') {
        return 'x86_64'
      }
      if (spec.script?.startsWith('getconf')) {
        return 'glibc 2.31'
      }
      if (spec.script?.startsWith('printf')) {
        return '/home/fake'
      }
      return 'broken runtime'
    })
    await expect(
      ensureWslPinnedRuntime(run, '/fake/cache', new AbortController().signal)
    ).rejects.toThrow('did not verify')
  })
  it('refuses a distro below the pinned glibc floor before downloading, naming both versions', async () => {
    mocks.download.mockClear()
    const run = runner(false, 'glibc 2.27')
    await expect(
      ensureWslPinnedRuntime(run, '/fake/cache', new AbortController().signal)
    ).rejects.toThrow('glibc 2.27 is older than 2.28')
    expect(mocks.download).not.toHaveBeenCalled()
    expect(
      run.mock.calls.some(([spec]) => spec.script?.includes('ORCA_NODE_RUNTIME_EXTRACT_FAILED'))
    ).toBe(false)
    await expect(
      ensureWslPinnedRuntime(
        runner(false, 'musl libc (x86_64)'),
        '/fake/cache',
        new AbortController().signal
      )
    ).resolves.toContain('/home/fake/.cache/orca')
  })
  it('gives a shared download its own deadline and lets each caller leave on its own signal', async () => {
    const archive = Promise.withResolvers<string>()
    let downloadSignal: AbortSignal | undefined
    mocks.download.mockReset().mockImplementation((_target, _root, options) => {
      downloadSignal = options.signal
      return archive.promise
    })
    const first = new AbortController()
    const second = new AbortController()
    const a = ensureWslPinnedRuntime(runner(), '/fake/cache', first.signal)
    const b = ensureWslPinnedRuntime(runner(), '/fake/cache', second.signal)
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(downloadSignal).not.toBe(first.signal)
    first.abort(new Error('first caller deadline'))
    await expect(a).rejects.toThrow('first caller deadline')
    expect(downloadSignal?.aborted).toBe(false)
    archive.resolve('C:/cache/pinned.tar.gz')
    await expect(b).resolves.toContain('/home/fake/.cache/orca')
    mocks.download.mockReset().mockImplementation(async () => 'C:/cache/pinned.tar.gz')
  })
})
