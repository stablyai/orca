import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCodexLoginSession } from './codex-login-session'

vi.mock('../../codex-cli/command', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCodexCommand: () => 'C:\\Tools\\codex.exe'
}))
vi.mock('../../providers/shell-launch/windows/windows-interactive-login-spawn', async () => {
  const { fakeWindowsInteractiveLoginSpawn } =
    await import('../../providers/shell-launch/windows/windows-interactive-login-spawn.test-fixture')
  return { buildWindowsHostInteractiveLoginSpawn: () => fakeWindowsInteractiveLoginSpawn(1) }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const roots: string[] = []

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

describe('runCodexLoginSession', () => {
  it('fails a Windows login whose relayed exit code is non-zero although start /wait exits 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'codex-login-'))
    roots.push(home)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    await expect(
      runCodexLoginSession(home, {
        wslCommand: 'wsl.exe',
        spawn: () => {
          const child = Object.assign(new EventEmitter(), {
            stdout: null,
            stderr: null,
            exitCode: null,
            signalCode: null,
            kill: () => true
          })
          setImmediate(() => child.emit('close', 0))
          return child
        },
        killProcessTree: vi.fn(),
        setCancel: vi.fn(),
        onAuthUrl: vi.fn()
      })
    ).rejects.toThrow('Codex login exited with code 1.')
  })
})
