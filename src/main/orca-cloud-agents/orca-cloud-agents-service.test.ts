import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentCredentialsView,
  OrcaCloudAgentSetups
} from '../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { AgentCredentialsClient } from './agent-credentials-client'
import type { SetupTokenProcess } from './claude-setup-token-runner'
import { createOrcaCloudAgentsService, isProviderSignInUrl } from './orca-cloud-agents-service'

const TOKEN = `sk-ant-oat01-${'Zz9_'.repeat(25)}`
const AUTHORIZE = 'https://claude.ai/oauth/authorize?code=true&state=s1'
const VIEW: AgentCredentialsView = {
  claude: { state: 'active', label: 'a@acme.dev' },
  codex: { state: 'none' },
  providerEnabled: { claude: true, codex: true }
}

function fakeChild() {
  let onData: (chunk: string) => void = () => {}
  let onExit: (code: number | null) => void = () => {}
  const child: SetupTokenProcess & { emit(c: string): void; exit(): void } = {
    onData: (l) => {
      onData = l
    },
    onExit: (l) => {
      onExit = l
    },
    kill: vi.fn(),
    write: vi.fn(),
    emit: (c) => onData(c),
    exit: () => onExit(0)
  }
  return child
}

function fakeClient(overrides: Partial<AgentCredentialsClient> = {}): AgentCredentialsClient {
  return {
    credentials: vi.fn(async () => VIEW),
    sources: vi.fn(async () => ({
      defaults: {},
      coveredByKey: { claude: false, codex: false }
    })),
    putClaude: vi.fn(async () => VIEW),
    remove: vi.fn(async () => VIEW),
    setDefaultSource: vi.fn(async () => ({
      defaults: { claude: 'sign-in' as const },
      coveredByKey: { claude: true, codex: false }
    })),
    setWorkspaceSource: vi.fn(async () => ({
      defaults: {},
      effective: { claude: { source: 'key' as const } },
      coveredByKey: { claude: true, codex: false }
    })),
    startCodexBroker: vi.fn(),
    codexBrokerStatus: vi.fn(),
    cancelCodexBroker: vi.fn(async () => {}),
    ...overrides
  }
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('orca cloud agents service', () => {
  const logged: unknown[][] = []
  beforeEach(() => {
    logged.length = 0
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args)
      })
    }
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function setup(client = fakeClient(), identity: () => string | null = () => 'p1:u1') {
    const child = fakeChild()
    const broadcasts: OrcaCloudAgentSetups[] = []
    const openExternal = vi.fn(async () => {})
    const service = createOrcaCloudAgentsService({
      client,
      spawnSetupToken: async () => child,
      readClaudeEmail: () => 'a@acme.dev',
      openExternal,
      broadcast: (setups) => broadcasts.push(setups),
      identity
    })
    return { service, child, broadcasts, openExternal, client }
  }

  /** Nothing the renderer or a log can see may contain the token. */
  function expectNoToken(...surfaces: unknown[]): void {
    for (const surface of [...surfaces, logged]) {
      expect(JSON.stringify(surface)).not.toContain(TOKEN)
      expect(JSON.stringify(surface)).not.toContain('sk-ant-oat01')
    }
  }

  it('captures the setup-token in main and stores it with the local account as label', async () => {
    const { service, child, broadcasts, client, openExternal } = setup()
    const reply = service.start('claude')
    await tick()
    child.emit(`Opening browser\n${AUTHORIZE}\n`)
    expect(service.setups().claude).toMatchObject({ phase: 'browser', canReopen: true })
    // "Copy link": the same page reopen opens, without opening it.
    expect(service.signInLink('claude')).toBe(AUTHORIZE)
    expect(service.signInLink('codex')).toBeNull()
    expect(openExternal).not.toHaveBeenCalled()
    expect(await service.reopen('claude')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith(AUTHORIZE)
    child.emit(`Your OAuth token (valid for 1 year):\n\n${TOKEN}\n\nStore this token`)
    child.exit()
    await tick()
    expect(client.putClaude).toHaveBeenCalledWith(TOKEN, 'a@acme.dev')
    expect(service.setups().claude).toEqual({ phase: 'saved' })
    expectNoToken(reply, broadcasts, service.setups(), await service.status())
  })

  it('offers the paste fallback when capture fails, and stores a pasted token without echoing it', async () => {
    const { service, child, broadcasts, client } = setup()
    service.start('claude')
    await tick()
    child.emit('unexpected output\n')
    child.exit()
    await tick()
    expect(service.setups().claude).toEqual({ phase: 'paste', reason: 'capture_failed' })
    const bad = await service.pasteClaudeToken('not a token')
    expect(bad).toEqual({ ok: false, error: 'invalid_token' })
    expect(client.putClaude).not.toHaveBeenCalled()
    const good = await service.pasteClaudeToken(`  ${TOKEN}\n`)
    expect(good).toEqual({ ok: true, value: true })
    expect(client.putClaude).toHaveBeenCalledWith(TOKEN, undefined)
    expectNoToken(bad, good, broadcasts)
  })

  it('keeps the token out of logs, replies and broadcasts when the control plane refuses it', async () => {
    const client = fakeClient({
      putClaude: vi.fn(async () => {
        throw new EnvironmentProviderError(
          'invalid_request',
          'Orca Cloud refused the request (invalid_request).',
          'invalid_token'
        )
      })
    })
    const { service, broadcasts } = setup(client)
    service.usePaste()
    const reply = await service.pasteClaudeToken(TOKEN)
    expect(reply).toEqual({ ok: false, error: 'invalid_token' })
    expect(service.setups().claude).toEqual({ phase: 'paste', reason: 'chosen', token: 'rejected' })
    expect(logged.length).toBeGreaterThan(0)
    expectNoToken(reply, broadcasts)
  })

  it('cancels a running setup-token and ignores its late output', async () => {
    const { service, child, client } = setup()
    service.start('claude')
    await tick()
    await service.cancel('claude')
    expect(child.kill).toHaveBeenCalled()
    child.emit(`${TOKEN}\n`)
    await tick()
    expect(client.putClaude).not.toHaveBeenCalled()
    expect(service.setups().claude).toEqual({ phase: 'idle' })
  })

  it('drops a captured token when the Orca account changed during setup', async () => {
    let who = 'p1:u1'
    const { service, child, client, broadcasts } = setup(fakeClient(), () => who)
    service.start('claude')
    await tick()
    who = 'p1:u2'
    child.emit(`${TOKEN}\n`)
    child.exit()
    await tick()
    expect(client.putClaude).not.toHaveBeenCalled()
    expect(broadcasts.at(-1)?.claude).toEqual({ phase: 'failed', error: 'signed_out' })
    // The next read under the new account starts clean.
    expect(service.setups().claude).toEqual({ phase: 'idle' })
  })

  it('does not let cancel or a paste race a token that is being stored', async () => {
    let release: () => void = () => {}
    const client = fakeClient({
      putClaude: vi.fn(
        () =>
          new Promise<AgentCredentialsView>((resolve) => {
            release = () => resolve(VIEW)
          })
      )
    })
    const { service } = setup(client)
    const first = service.pasteClaudeToken(TOKEN)
    await tick()
    expect(service.setups().claude).toEqual({ phase: 'saving' })
    await service.cancel('claude')
    expect(await service.pasteClaudeToken(TOKEN)).toEqual({ ok: false, error: 'unavailable' })
    expect(service.setups().claude).toEqual({ phase: 'saving' })
    release()
    expect(await first).toEqual({ ok: true, value: true })
    expect(client.putClaude).toHaveBeenCalledTimes(1)
  })

  it('reports not_configured without a control plane', () => {
    const service = createOrcaCloudAgentsService({
      client: null,
      spawnSetupToken: async () => fakeChild(),
      readClaudeEmail: () => null,
      openExternal: vi.fn(),
      broadcast: vi.fn()
    })
    expect(service.start('claude')).toEqual({ ok: false, error: 'not_configured' })
  })

  it('opens only the provider sign-in pages', () => {
    expect(isProviderSignInUrl('claude', AUTHORIZE)).toBe(true)
    expect(isProviderSignInUrl('claude', 'https://claude.ai.evil.example/oauth')).toBe(false)
    expect(isProviderSignInUrl('codex', 'https://auth.openai.com/codex/device')).toBe(true)
    expect(isProviderSignInUrl('codex', 'http://auth.openai.com/codex/device')).toBe(false)
    expect(isProviderSignInUrl('codex', 'https://openai.com.evil.example/')).toBe(false)
  })
})
