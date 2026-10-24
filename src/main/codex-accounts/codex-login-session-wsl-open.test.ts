import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: vi.fn(async () => ({
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false
  }))
}))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))

import { runCodexLoginSession, type CodexLoginSpawnRequest } from './codex-login-session'

const AUTH_URL = 'https://auth.openai.com/oauth/authorize?client_id=orca&state=abc'
const PRINTED = `If your browser did not open, navigate to this URL to authenticate:\n\n${AUTH_URL}\n`
const WSL_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\managed-home'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function loginThatPrints(text: string) {
  const requests: CodexLoginSpawnRequest[] = []
  const spawn = vi.fn((request: CodexLoginSpawnRequest) => {
    requests.push(request)
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true
    })
    queueMicrotask(() => {
      child.stdout.write(text)
      setTimeout(() => child.emit('close', 0), 10)
    })
    return child
  })
  return { spawn, requests }
}

function run(
  home: string,
  login: ReturnType<typeof loginThatPrints>,
  openWslAuthUrl?: (url: string) => void
) {
  const onAuthUrl = vi.fn()
  const done = runCodexLoginSession(home, {
    wslCommand: 'wsl.exe',
    spawn: login.spawn,
    killProcessTree: vi.fn(),
    setCancel: vi.fn(),
    onAuthUrl,
    openWslAuthUrl
  })
  return { done, onAuthUrl }
}

describe('runCodexLoginSession sign-in link opening', () => {
  it('opens the link a WSL login prints and keeps it for Copy link', async () => {
    const login = loginThatPrints(PRINTED)
    const open = vi.fn()
    const { done, onAuthUrl } = run(WSL_HOME, login, open)
    await done
    expect(open).toHaveBeenCalledExactlyOnceWith(AUTH_URL)
    expect(onAuthUrl).toHaveBeenCalledExactlyOnceWith(AUTH_URL)
    // Suppress the distro opener to avoid a second browser tab.
    expect(login.requests[0].args.at(-1)).toContain('export BROWSER=true')
  })

  it('leaves a WSL login as it was where nothing can open a link', async () => {
    const login = loginThatPrints(PRINTED)
    const { done, onAuthUrl } = run(WSL_HOME, login)
    await done
    expect(onAuthUrl).toHaveBeenCalledExactlyOnceWith(AUTH_URL)
    expect(login.requests[0].args.at(-1)).not.toContain('BROWSER')
  })

  it('never opens a link the WSL login did not print as its sign-in link', async () => {
    const login = loginThatPrints(
      'Update available: https://github.com/openai/codex/releases\nnavigate to this URL to authenticate: http://auth.openai.com/x\n'
    )
    const open = vi.fn()
    await run(WSL_HOME, login, open).done
    expect(open).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'leaves a local login to open its own browser',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'codex-login-session-'))
      roots.push(home)
      const login = loginThatPrints(PRINTED)
      const open = vi.fn()
      const { done, onAuthUrl } = run(home, login, open)
      await done
      expect(onAuthUrl).toHaveBeenCalledExactlyOnceWith(AUTH_URL)
      expect(open).not.toHaveBeenCalled()
      expect(login.requests[0].env.BROWSER).toBe(process.env.BROWSER)
    }
  )
})
