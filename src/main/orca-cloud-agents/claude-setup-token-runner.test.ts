import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findAuthorizeUrl,
  findSetupToken,
  runClaudeSetupToken,
  type SetupTokenProcess
} from './claude-setup-token-runner'

const TOKEN = `sk-ant-oat01-${'Ab3_-x'.repeat(16)}`
const AUTHORIZE =
  'https://claude.ai/oauth/authorize?code=true&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A5555%2Fcallback'

type FakeChild = SetupTokenProcess & {
  emit: (chunk: string) => void
  exit: (code: number | null) => void
  killed: boolean
}

function fakeChild(): FakeChild {
  let onData: (chunk: string) => void = () => {}
  let onExit: (code: number | null) => void = () => {}
  const child: FakeChild = {
    killed: false,
    onData: (listener) => {
      onData = listener
    },
    onExit: (listener) => {
      onExit = listener
    },
    kill: () => {
      child.killed = true
    },
    write: () => {},
    emit: (chunk) => onData(chunk),
    exit: (code) => onExit(code)
  }
  return child
}

async function started(child: FakeChild) {
  const controller = new AbortController()
  const onAuthorizeUrl = vi.fn()
  const outcome = runClaudeSetupToken({
    spawn: async () => child,
    signal: controller.signal,
    timeoutMs: 10_000,
    onAuthorizeUrl
  })
  // Let the spawn promise settle so listeners are attached.
  await Promise.resolve()
  await Promise.resolve()
  return { outcome, controller, onAuthorizeUrl }
}

describe('findSetupToken', () => {
  it('reads a token once a non-token character ends it', () => {
    expect(findSetupToken(`Your OAuth token:\n\n${TOKEN}\n\nStore it`, false)).toBe(TOKEN)
    expect(findSetupToken(`Your OAuth token:\n${TOKEN}`, false)).toBeNull()
    expect(findSetupToken(`Your OAuth token:\n${TOKEN}`, true)).toBe(TOKEN)
  })

  it('drops styling inside the token but breaks on cursor moves around it', () => {
    const styled = `${TOKEN.slice(0, 30)}\u001b[?25l\u001b[1m${TOKEN.slice(30)}\u001b[22m`
    expect(findSetupToken(`${styled}\n`, false)).toBe(TOKEN)
    expect(findSetupToken(`${TOKEN}\u001b[7;1HStore this token`, false)).toBe(TOKEN)
  })

  it('prefers the whole token over a copy a repaint cut short', () => {
    const cut = `${TOKEN.slice(0, 40)}\u001b[3;1H${TOKEN.slice(40)}`
    expect(findSetupToken(`${cut}\n${TOKEN}\n`, false)).toBe(TOKEN)
  })

  it('ignores anything that is not a setup-token', () => {
    expect(findSetupToken('sk-ant-oat01-short ', false)).toBeNull()
    expect(findSetupToken(`sk-ant-api03-${'a'.repeat(40)} `, false)).toBeNull()
  })
})

describe('findAuthorizeUrl', () => {
  it("finds Claude's sign-in page and nothing else", () => {
    expect(findAuthorizeUrl(`Browser didn't open? Use the url below:\n${AUTHORIZE}\n`)).toBe(
      new URL(AUTHORIZE).toString()
    )
    expect(findAuthorizeUrl('see https://evil.example/oauth/authorize?x=1 \n')).toBeNull()
  })
})

describe('runClaudeSetupToken', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('captures the token across chunks and reports the sign-in link once', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const { outcome, onAuthorizeUrl } = await started(child)
    child.emit(`Opening browser…\n${AUTHORIZE}\n`)
    child.emit(`${AUTHORIZE}\n`)
    child.emit(`\u001b[32m✓\u001b[0m Your token:\n${TOKEN.slice(0, 30)}`)
    child.emit(`${TOKEN.slice(30)}\n`)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(outcome).resolves.toEqual({ ok: true, token: TOKEN })
    expect(onAuthorizeUrl).toHaveBeenCalledTimes(1)
    // The child exits on its own; the backstop kills it only if it doesn't.
    expect(child.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(child.killed).toBe(true)
  })

  it('waits for a repaint before settling on a token', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const { outcome } = await started(child)
    child.emit(`${TOKEN.slice(0, 40)}\u001b[3;1H${TOKEN.slice(40)}\n`)
    child.emit(`\u001b[2J${TOKEN}\n`)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(outcome).resolves.toEqual({ ok: true, token: TOKEN })
  })

  it('takes a token printed right before exit', async () => {
    const child = fakeChild()
    const { outcome } = await started(child)
    child.emit(TOKEN)
    child.exit(0)
    await expect(outcome).resolves.toEqual({ ok: true, token: TOKEN })
  })

  it('offers the paste fallback when setup-token ends without a token', async () => {
    const child = fakeChild()
    const { outcome } = await started(child)
    child.emit('Something went wrong\n')
    child.exit(1)
    await expect(outcome).resolves.toEqual({ ok: false, error: 'capture_failed' })
  })

  it('reports a missing claude as no_cli', async () => {
    const outcome = await runClaudeSetupToken({
      spawn: async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      },
      signal: new AbortController().signal
    })
    expect(outcome).toEqual({ ok: false, error: 'no_cli' })
  })

  it('stops on a denied sign-in', async () => {
    const child = fakeChild()
    const { outcome } = await started(child)
    child.emit('Error: access_denied\n')
    await expect(outcome).resolves.toEqual({ ok: false, error: 'denied' })
    expect(child.killed).toBe(true)
  })

  it('kills the child on cancel and on timeout', async () => {
    const cancelled = fakeChild()
    const first = await started(cancelled)
    first.controller.abort()
    await expect(first.outcome).resolves.toEqual({ ok: false, error: 'cancelled' })
    expect(cancelled.killed).toBe(true)

    vi.useFakeTimers()
    const slow = fakeChild()
    const second = await started(slow)
    vi.advanceTimersByTime(10_001)
    await expect(second.outcome).resolves.toEqual({ ok: false, error: 'timed_out' })
    expect(slow.killed).toBe(true)
  })
})

describe('setupTokenInvocation', () => {
  it('runs a Windows shim through cmd with the shared quoting, as one verbatim line', async () => {
    const { setupTokenInvocation } = await import('./claude-setup-token-pty')
    const shim = 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\npm\\claude.cmd'
    const windows = setupTokenInvocation(shim, 'win32')
    expect(typeof windows.args).toBe('string')
    expect(windows.args).toBe(`/d /v:off /s /c ""${shim}" "setup-token""`)
    expect(setupTokenInvocation('/usr/local/bin/claude', 'darwin')).toEqual({
      file: '/usr/local/bin/claude',
      args: ['setup-token']
    })
  })
})
