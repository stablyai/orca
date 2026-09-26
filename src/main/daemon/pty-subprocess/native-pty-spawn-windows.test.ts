import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnNativeDaemonPty } from './native-pty-spawn'
import { WindowsBunPtySpawnUnconfirmedError } from './windows-bun-pty-spawn-receipt'

const attempts = ['pwsh.exe', 'powershell.exe', 'cmd.exe'].map((shellPath) => ({
  shellPath,
  shellArgs: [shellPath === 'cmd.exe' ? '/K' : '-NoExit'],
  effectiveCwd: 'C:\\work',
  validationCwd: 'C:\\work',
  startupCommandDeliveredInShellArgs: true
}))
const args = {
  shellPath: attempts[0]!.shellPath,
  shellArgs: attempts[0]!.shellArgs,
  spawnCwd: 'C:\\work',
  env: {},
  cols: 80,
  rows: 24,
  windowsFallbackAttempts: attempts
}

function createProcess(waitForSpawn: () => Promise<void>) {
  return {
    pid: 9876,
    cols: 80,
    rows: 24,
    process: 'gate',
    handleFlowControl: false,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    clear: vi.fn(),
    kill: vi.fn(),
    destroy: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    waitForSpawn
  }
}

describe('Windows Bun shell fallback after gated spawn', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', platform)
    vi.restoreAllMocks()
  })

  it('walks both fallback shells when gate wrappers start but their actual shells fail', async () => {
    const spawnBunPty = vi.fn(({ file }: { file: string }) =>
      createProcess(async () => {
        await Promise.resolve()
        if (file !== 'cmd.exe') {
          throw new Error(`spawn ${file} EACCES`)
        }
      })
    )
    const result = await spawnNativeDaemonPty(args, { canUseBunPty: () => true, spawnBunPty })
    expect(spawnBunPty.mock.calls.map(([args]) => args.file)).toEqual([
      'pwsh.exe',
      'powershell.exe',
      'cmd.exe'
    ])
    expect(result.shellPath).toBe('cmd.exe')
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
    expect(spawnBunPty.mock.results[0]!.value.destroy).toHaveBeenCalledOnce()
    expect(spawnBunPty.mock.results[1]!.value.destroy).toHaveBeenCalledOnce()
    expect(spawnBunPty.mock.results[2]!.value.destroy).not.toHaveBeenCalled()
  })

  it('does not report a wrapper as a working shell before its actual spawn is confirmed', async () => {
    let confirm!: () => void
    const confirmation = new Promise<void>((resolve) => {
      confirm = resolve
    })
    const finished = vi.fn()
    const spawnBunPty = vi.fn(() => createProcess(() => confirmation))
    const result = spawnNativeDaemonPty(args, { canUseBunPty: () => true, spawnBunPty }).then(
      finished
    )
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    confirm()
    await result
    expect(finished).toHaveBeenCalledOnce()
  })

  it('destroys an unconfirmed gate on cancellation without starting a fallback shell', async () => {
    const controller = new AbortController()
    const proc = createProcess(() => new Promise(() => {}))
    const spawnBunPty = vi.fn(() => proc)
    const result = spawnNativeDaemonPty(
      { ...args, signal: controller.signal },
      { canUseBunPty: () => true, spawnBunPty }
    )
    controller.abort(new Error('spawn canceled'))
    await expect(result).rejects.toThrow('spawn canceled')
    expect(proc.destroy).toHaveBeenCalledOnce()
    expect(spawnBunPty).toHaveBeenCalledOnce()
  })

  it.each([0, 1])(
    'stops at an ambiguous attempt %s to avoid running its startup command twice',
    async (ambiguousIndex) => {
      const spawnBunPty = vi.fn(({ file }: { file: string }) =>
        createProcess(async () => {
          if (file === attempts[ambiguousIndex]!.shellPath) {
            throw new WindowsBunPtySpawnUnconfirmedError('missing receipt')
          }
          throw new Error('spawn ENOENT')
        })
      )
      await expect(
        spawnNativeDaemonPty(args, { canUseBunPty: () => true, spawnBunPty })
      ).rejects.toBeInstanceOf(WindowsBunPtySpawnUnconfirmedError)
      expect(spawnBunPty).toHaveBeenCalledTimes(ambiguousIndex + 1)
      expect(spawnBunPty.mock.results.at(-1)!.value.destroy).toHaveBeenCalledOnce()
    }
  )
})
