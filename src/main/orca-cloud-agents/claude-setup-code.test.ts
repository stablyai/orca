// P0 "Set up once": Claude's setup-token ends on Anthropic's "Authentication code — Paste this into
// Claude Code" page. The code comes back through Orca (strip, Settings, chat UI) into the waiting CLI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAgentSetups } from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { AgentCredentialsClient } from './agent-credentials-client'
import { normalizeClaudeSetupCode } from './claude-setup-code'
import {
  runClaudeSetupToken,
  type SetupTokenProcess,
  type SubmitSetupCode
} from './claude-setup-token-runner'
import { createOrcaCloudAgentsService } from './orca-cloud-agents-service'

const TOKEN = `sk-ant-oat01-${'Qq7_'.repeat(25)}`
// What setup-token 2.1.319 prints (manual redirect: Anthropic's code page).
const AUTHORIZE =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1'
const PROMPT = 'Paste code here if prompted > '
// A recorded-shape fake: never a real code.
const CODE = 'FAKEcode0123456789abcdef#FAKEstate0123456789'
const REJECTED =
  "OAuth error: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt.\n Press Enter to retry.\n"

function fakeChild() {
  let onData: (chunk: string) => void = () => {}
  let onExit: (code: number | null) => void = () => {}
  const writes: string[] = []
  const child: SetupTokenProcess & { emit(c: string): void; exit(): void; writes: string[] } = {
    writes,
    onData: (l) => {
      onData = l
    },
    onExit: (l) => {
      onExit = l
    },
    kill: vi.fn(),
    write: (data) => void writes.push(data),
    emit: (c) => onData(c),
    exit: () => onExit(0)
  }
  return child
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('normalizeClaudeSetupCode', () => {
  it('takes the bare code, trimmed', () => {
    expect(normalizeClaudeSetupCode(`  ${CODE}\n`)).toBe(CODE)
  })
  it("takes the whole callback URL from the browser's address bar", () => {
    expect(
      normalizeClaudeSetupCode(
        'https://platform.claude.com/oauth/code/callback?code=FAKEcode0123456789abcdef&state=FAKEstate0123456789'
      )
    ).toBe(CODE)
  })
  it('refuses anything else, including another site', () => {
    expect(normalizeClaudeSetupCode('hello world')).toBeNull()
    expect(
      normalizeClaudeSetupCode('https://evil.test/cb?code=FAKEcode0123456789&state=x1234567')
    ).toBeNull()
    expect(normalizeClaudeSetupCode(TOKEN)).toBeNull()
  })
})

describe('runClaudeSetupToken with a pasted code', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  async function started() {
    const child = fakeChild()
    const submits: SubmitSetupCode[] = []
    const onCodeRejected = vi.fn()
    const outcome = runClaudeSetupToken({
      spawn: async () => child,
      signal: new AbortController().signal,
      timeoutMs: 600_000,
      onAcceptsCode: (submit) => void submits.push(submit),
      onCodeRejected
    })
    await tick()
    return { child, submits, onCodeRejected, outcome }
  }

  it('types the code, then Enter, into the waiting CLI and captures the token it prints', async () => {
    const { child, submits, outcome } = await started()
    expect(submits).toHaveLength(0)
    child.emit(`Browser didn't open? Use the url below to sign in\n${AUTHORIZE}\n${PROMPT}`)
    expect(submits).toHaveLength(1)
    expect(submits[0]!(CODE)).toBe(true)
    // One code at a time until the CLI answers.
    expect(submits[0]!(CODE)).toBe(false)
    expect(child.writes).toEqual([CODE])
    await vi.advanceTimersByTimeAsync(200)
    expect(child.writes).toEqual([CODE, '\r'])
    child.emit(`Your OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token`)
    await vi.advanceTimersByTimeAsync(1_100)
    await expect(outcome).resolves.toEqual({ ok: true, token: TOKEN })
  })

  it('on a refused code starts over in the same run: Enter for a new link, which takes a new code', async () => {
    const { child, submits, onCodeRejected } = await started()
    child.emit(`${AUTHORIZE}\n${PROMPT}`)
    submits[0]!(CODE)
    await vi.advanceTimersByTimeAsync(200)
    child.emit(REJECTED)
    expect(onCodeRejected).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(child.writes).toEqual([CODE, '\r', '\r'])
    // The spent submitter refuses; the new link brings a new one.
    expect(submits[0]!(CODE)).toBe(false)
    child.emit(`${AUTHORIZE.replace('state=s1', 'state=s2')}\n${PROMPT}`)
    expect(submits).toHaveLength(2)
    expect(submits[1]!(CODE)).toBe(true)
  })
})

describe('service: the code from the strip, Settings or the chat UI', () => {
  const logged: unknown[][] = []
  beforeEach(() => {
    logged.length = 0
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args))
    }
  })
  afterEach(() => vi.restoreAllMocks())

  function setup() {
    const children: ReturnType<typeof fakeChild>[] = []
    const broadcasts: OrcaCloudAgentSetups[] = []
    const view = {
      claude: { state: 'active' },
      codex: { state: 'none' },
      providerEnabled: { claude: true, codex: true }
    } as const
    const client: AgentCredentialsClient = {
      credentials: vi.fn(async () => view),
      sources: vi.fn(async () => ({ defaults: {}, coveredByKey: { claude: false, codex: false } })),
      putClaude: vi.fn(async () => view),
      remove: vi.fn(async () => view),
      setDefaultSource: vi.fn(),
      setWorkspaceSource: vi.fn(),
      startCodexBroker: vi.fn(),
      codexBrokerStatus: vi.fn(),
      cancelCodexBroker: vi.fn(async () => {})
    }
    const service = createOrcaCloudAgentsService({
      client,
      spawnSetupToken: async () => {
        const child = fakeChild()
        children.push(child)
        return child
      },
      readClaudeEmail: () => null,
      openExternal: vi.fn(async () => {}),
      broadcast: (setups) => broadcasts.push(setups),
      identity: () => 'p1:u1'
    })
    return { service, children, broadcasts, client }
  }

  it('shows the code field once the CLI waits for it, checks it, and saves the token; the code is never echoed', async () => {
    const { service, children, broadcasts, client } = setup()
    service.start('claude')
    await tick()
    expect(service.setups().claude).toMatchObject({ phase: 'browser' })
    expect(service.submitClaudeCode(CODE)).toEqual({ ok: false, error: 'unavailable' })
    children[0]!.emit(`${AUTHORIZE}\n${PROMPT}`)
    expect(service.setups().claude).toMatchObject({
      phase: 'browser',
      acceptsCode: true,
      canReopen: true
    })
    expect(service.submitClaudeCode('not a code')).toEqual({ ok: false, error: 'invalid_code' })
    expect(service.submitClaudeCode(`  ${CODE} `)).toEqual({ ok: true, value: true })
    expect(service.setups().claude).toMatchObject({ phase: 'browser', code: 'checking' })
    expect(children[0]!.writes[0]).toBe(CODE)
    children[0]!.emit(`Your OAuth token:\n\n${TOKEN}\n\n`)
    children[0]!.exit()
    await tick()
    expect(client.putClaude).toHaveBeenCalledWith(TOKEN, undefined)
    expect(service.setups().claude).toEqual({ phase: 'saved' })
    for (const surface of [broadcasts, logged]) {
      expect(JSON.stringify(surface)).not.toContain('FAKEcode')
      expect(JSON.stringify(surface)).not.toContain('sk-ant-oat01')
    }
  })

  it('a refused code shows "rejected" and the field again for the next code', async () => {
    vi.useFakeTimers()
    try {
      const { service, children } = setup()
      service.start('claude')
      await tick()
      children[0]!.emit(`${AUTHORIZE}\n${PROMPT}`)
      service.submitClaudeCode(CODE)
      children[0]!.emit(REJECTED)
      expect(service.setups().claude).toMatchObject({ phase: 'browser', code: 'rejected' })
      expect(service.submitClaudeCode(CODE)).toEqual({ ok: false, error: 'unavailable' })
      await vi.advanceTimersByTimeAsync(600)
      children[0]!.emit(`${AUTHORIZE}\n${PROMPT}`)
      expect(service.setups().claude).toMatchObject({ phase: 'browser', acceptsCode: true })
      expect(service.submitClaudeCode(CODE)).toEqual({ ok: true, value: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a sign-in whose CLI goes away shows expired, and "Open again" starts a fresh run with a new link', async () => {
    const { service, children } = setup()
    service.start('claude')
    await tick()
    children[0]!.emit(`${AUTHORIZE}\n${PROMPT}`)
    children[0]!.exit()
    await tick()
    expect(service.setups().claude).toEqual({ phase: 'failed', error: 'timed_out' })
    expect(await service.reopen('claude')).toBe(true)
    await tick()
    expect(children).toHaveLength(2)
    expect(service.setups().claude).toMatchObject({ phase: 'browser', canReopen: false })
  })

  it('the 10-minute timeout also ends as expired, not a silent spin', async () => {
    vi.useFakeTimers()
    try {
      const { service, children } = setup()
      service.start('claude')
      await tick()
      children[0]!.emit(`${AUTHORIZE}\n${PROMPT}`)
      await vi.advanceTimersByTimeAsync(600_001)
      await tick()
      expect(service.setups().claude).toEqual({ phase: 'failed', error: 'timed_out' })
    } finally {
      vi.useRealTimers()
    }
  })
})
