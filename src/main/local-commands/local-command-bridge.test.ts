import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalCommandSettleParams } from '../../shared/local-commands/local-command-contract'
import type { LocalCommandPrompt } from '../../shared/local-commands/local-command-desktop-types'
import { LocalCommandAuditLog } from './local-command-audit-log'
import { createLocalCommandBridge } from './local-command-bridge'
import type { LocalCommandWorkspacePolicy } from './local-command-request-checks'
import { LocalCommandSettingsStore } from './local-command-settings-store'

const SANDBOX = 'sbx_0123456789abcdef01234567'
const ENV = 'env-1'
const REQUEST = 'lc_request000000000001'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function setup(
  options: {
    policy?: LocalCommandWorkspacePolicy | null
    enabled?: boolean
    /** Runs stay in flight until release() is called. */
    holdRuns?: boolean
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'local-commands-'))
  dirs.push(dir)
  let clock = 10_000
  const settings = new LocalCommandSettingsStore(dir)
  await settings.load()
  if (options.enabled !== false) {
    settings.setEnabled(SANDBOX, true, false, clock)
  }
  const audit = new LocalCommandAuditLog(dir)
  const settled: LocalCommandSettleParams[] = []
  const executed: { command: string; cwd: string }[] = []
  let prompts: LocalCommandPrompt[] = []
  let onEvent: (event: unknown) => void = () => {}
  const timers: (() => void)[] = []
  const held: (() => void)[] = []
  const bridge = createLocalCommandBridge({
    settings,
    audit,
    supported: true,
    listWorkspaces: () => [
      { sandboxId: SANDBOX, runtimeEnvironmentId: ENV, fallbackLabel: 'api-fix' }
    ],
    readPolicy: async () =>
      options.policy === undefined
        ? { isOwner: true, shared: false, title: 'api-fix' }
        : options.policy,
    subscribe: async (_env, handler) => {
      onEvent = handler
      return { close: () => {} }
    },
    settle: async (_env, params) => {
      settled.push(params)
      return { accepted: true }
    },
    resolveCwd: async (cwd) => (cwd === '/missing' ? null : '/Users/me'),
    execute: async ({ command, cwd }) => {
      executed.push({ command, cwd })
      if (options.holdRuns) {
        await new Promise<void>((resolve) => held.push(resolve))
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 3,
        stdout: 'done',
        stderr: '',
        truncated: false,
        stdoutBytes: 4,
        stderrBytes: 0
      }
    },
    publishPrompts: (next) => {
      prompts = next
    },
    publishState: () => {},
    now: () => clock,
    setTimer: (run) => {
      timers.push(run)
      return { cancel: () => {} }
    },
    log: () => {}
  })
  bridge.reconcile()
  const request = async (overrides: Record<string, unknown> = {}): Promise<void> => {
    onEvent({
      type: 'requested',
      requestId: REQUEST,
      command: 'xcrun simctl list',
      cwd: null,
      timeoutSec: 60,
      reason: 'Find the booted simulator',
      agent: 'claude',
      expiresInMs: 300_000,
      ...overrides
    })
    await vi.waitFor(() => {
      expect(prompts.length + settled.length + executed.length).toBeGreaterThan(0)
    })
  }
  // Sends a request with its own id and lets the bridge's async checks finish.
  const send = async (id: string, overrides: Record<string, unknown> = {}): Promise<void> => {
    onEvent({
      type: 'requested',
      requestId: id,
      command: 'xcrun simctl list',
      cwd: null,
      timeoutSec: 60,
      reason: null,
      agent: null,
      expiresInMs: 300_000,
      ...overrides
    })
    // The bridge's checks resolve on already-settled promises; let them run to the end.
    for (let turn = 0; turn < 50; turn += 1) {
      await Promise.resolve()
    }
  }
  return {
    bridge,
    send,
    release: () => held.splice(0).forEach((resolve) => resolve()),
    settings,
    audit,
    settled,
    executed,
    timers,
    request,
    prompts: () => prompts,
    advance: (ms: number) => {
      clock += ms
    }
  }
}

describe('local command bridge', () => {
  it('refuses without asking when the workspace is shared and the owner did not allow that', async () => {
    const t = await setup({ policy: { isOwner: true, shared: true, title: 'api-fix' } })
    await t.request()
    expect(t.prompts()).toEqual([])
    expect(t.executed).toEqual([])
    expect(t.settled).toEqual([{ requestId: REQUEST, outcome: 'declined', reason: 'not_allowed' }])
    expect((await t.audit.recent(1))[0]).toMatchObject({ outcome: 'refused' })
  })

  it("refuses when this person doesn't own the workspace, or ownership can't be read", async () => {
    for (const policy of [{ isOwner: false, shared: false, title: null }, null]) {
      const t = await setup({ policy })
      await t.request()
      expect(t.executed).toEqual([])
      expect(t.settled[0]).toMatchObject({ outcome: 'declined', reason: 'not_allowed' })
    }
  })

  it('refuses a command with hidden characters', async () => {
    const t = await setup()
    await t.request({ command: 'echo safe\u202E; rm -rf ~' })
    expect(t.prompts()).toEqual([])
    expect(t.executed).toEqual([])
    expect(t.settled[0]).toMatchObject({ outcome: 'declined', reason: 'not_allowed' })
  })

  it('asks, then runs exactly the command it showed after Allow once', async () => {
    const t = await setup()
    await t.request()
    expect(t.prompts()).toEqual([
      expect.objectContaining({ id: REQUEST, command: 'xcrun simctl list', cwd: '/Users/me' })
    ])
    expect(await t.bridge.decide(REQUEST, 'allow-once')).toEqual({ ok: false, error: 'too_soon' })
    t.advance(1_000)
    expect(await t.bridge.decide(REQUEST, 'allow-once')).toEqual({ ok: true })
    await vi.waitFor(() => expect(t.settled.map((s) => s.outcome)).toEqual(['started', 'finished']))
    expect(t.executed).toEqual([{ command: 'xcrun simctl list', cwd: '/Users/me' }])
    expect((await t.audit.recent(1))[0]).toMatchObject({ outcome: 'allowed-once', exitCode: 0 })
  })

  it('runs an always-allowed command next time without asking', async () => {
    const t = await setup()
    t.settings.addRule(SANDBOX, 'xcrun simctl list', '/Users/me', 1)
    await t.request()
    await vi.waitFor(() => expect(t.executed).toHaveLength(1))
    expect(t.prompts()).toEqual([])
    expect((await t.audit.recent(1))[0]).toMatchObject({ outcome: 'auto-allowed' })
  })

  it('reports an unanswered prompt as not answered, not as denied', async () => {
    const t = await setup()
    await t.request()
    t.timers.at(-1)!()
    expect(t.settled).toEqual([
      { requestId: REQUEST, outcome: 'declined', reason: 'approval_timed_out' }
    ])
    expect(t.executed).toEqual([])
  })

  it('does not run when the workspace was turned off while the prompt was open', async () => {
    const t = await setup()
    await t.request()
    t.settings.setEnabled(SANDBOX, false, false, 2)
    t.advance(1_000)
    expect(await t.bridge.decide(REQUEST, 'allow-once')).toEqual({
      ok: false,
      error: 'not_allowed'
    })
    expect(t.executed).toEqual([])
  })

  it('stops asking after three waiting prompts from one workspace', async () => {
    const t = await setup()
    for (let index = 0; index < 5; index += 1) {
      await t.send(`lc_flood${String(index).padStart(14, '0')}`)
    }
    expect(t.prompts()).toHaveLength(3)
    expect(t.settled.filter((s) => s.outcome === 'declined')).toHaveLength(2)
    expect(t.executed).toEqual([])
  })

  it('runs an always-allowed command one at a time and asks about the next one', async () => {
    const t = await setup({ holdRuns: true })
    t.settings.addRule(SANDBOX, 'xcrun simctl list', '/Users/me', 1)
    await t.send('lc_rule00000000000000001')
    await t.send('lc_rule00000000000000002')
    expect(t.executed).toHaveLength(1)
    expect(t.prompts().map((p) => p.id)).toEqual(['lc_rule00000000000000002'])
    t.release()
  })
})
