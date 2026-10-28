import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { WINDOWS_ONLY_AGENT_CLI_DIR } from '../codex-cli/windows-only-agent-cli'

vi.mock('../codex-cli/command', () => ({
  resolveCodexCommand: () => '/proc/orca-agent-cli-installed-only-on-windows/codex'
}))

import { runCodexLoginSession } from './codex-login-session'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

it.skipIf(process.platform === 'win32')(
  'tells a WSL host user Codex is installed only on Windows, not that Node is missing',
  async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-codex-login-'))
    roots.push(home)
    const spawn = vi.fn((request: { command: string }) => {
      expect(request.command).toBe(`${WINDOWS_ONLY_AGENT_CLI_DIR}/codex`)
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        kill: () => true
      })
      queueMicrotask(() =>
        child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      )
      return child
    })
    await expect(
      runCodexLoginSession(home, {
        wslCommand: 'wsl.exe',
        spawn,
        killProcessTree: vi.fn(),
        setCancel: vi.fn(),
        onAuthUrl: vi.fn()
      })
    ).rejects.toThrow(
      'Codex is installed only on Windows, not in this WSL distro. Install it inside the distro.'
    )
  }
)
