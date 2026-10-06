import { afterEach, expect, it, vi } from 'vitest'
import { CODEX_LOGIN_CANCELLED_MESSAGE } from '../../shared/codex-auth-errors'

const hostResolution = vi.hoisted(() => ({ warm: vi.fn() }))
vi.mock('../../shared/windows-powershell-host', () => ({
  warmWindowsPowerShellHostCache: hostResolution.warm
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  hostResolution.warm.mockReset()
})

it('cancels before spawning while the shared Windows host probe is still pending', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  let resolveHost!: (host: string) => void
  hostResolution.warm.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        resolveHost = resolve
      })
  )
  let cancelLogin: (() => boolean) | undefined
  const spawn = vi.fn()
  const { runCodexLoginSession } = await import('./codex-login-session')
  const login = runCodexLoginSession('C:\\missing-orca-test-home', {
    wslCommand: 'wsl.exe',
    spawn,
    killProcessTree: vi.fn(),
    setCancel: (cancel) => {
      cancelLogin = cancel
    },
    onAuthUrl: vi.fn()
  })
  expect(hostResolution.warm).toHaveBeenCalledOnce()
  expect(cancelLogin?.()).toBe(true)
  await expect(login).rejects.toThrow(CODEX_LOGIN_CANCELLED_MESSAGE)
  resolveHost('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  await Promise.resolve()
  expect(spawn).not.toHaveBeenCalled()
})
