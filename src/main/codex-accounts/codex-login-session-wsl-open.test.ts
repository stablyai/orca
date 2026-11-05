import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../wsl/execution/wsl-runner', () => ({
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
type FakeLogin = EventEmitter & { stdout: PassThrough; stderr: PassThrough }
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function loginThatPrints(
  text: string,
  stream: 'stdout' | 'stderr' | ((child: FakeLogin) => void) = 'stdout'
) {
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
      if (typeof stream === 'function') {
        stream(child)
      } else {
        child[stream].write(text)
      }
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
  it('reads a link split across stderr chunks despite stdout output between them', async () => {
    const half = PRINTED.length - 20
    const login = loginThatPrints('', (child) => {
      child.stderr.write(PRINTED.slice(0, half))
      child.stdout.write('unrelated progress\n')
      child.stderr.write(PRINTED.slice(half))
    })
    const open = vi.fn()
    const { done, onAuthUrl } = run(WSL_HOME, login, open)
    await done
    expect(onAuthUrl).toHaveBeenCalledExactlyOnceWith(AUTH_URL)
    expect(open).toHaveBeenCalledExactlyOnceWith(AUTH_URL)
  })
})
