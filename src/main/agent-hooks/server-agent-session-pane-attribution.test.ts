import { describe, expect, it, vi } from 'vitest'

import { AgentHookServer, isValidPaneKey, _internals } from './server'
import {
  createHookListenerState,
  normalizeHookPayload,
  readHookBodyProviderSessionId
} from '../../shared/agent-hook-listener'
import { makePaneKey } from '../../shared/stable-pane-id'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

// Why: split panes live in ONE tab — same tabId, different leaf. The daemon's
// inherited key names a pane in a different workspace entirely.
const SPLIT_LEAF_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const SPLIT_LEAF_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const DAEMON_LEAF = 'cccccccc-3333-4333-8333-333333333333'

const SPLIT_PANE_A = makePaneKey('tab-split', SPLIT_LEAF_A)
const SPLIT_PANE_B = makePaneKey('tab-split', SPLIT_LEAF_B)
/** The pane that first spawned the shared daemon; every later worker inherits its env. */
const DAEMON_PANE = makePaneKey('tab-daemon', DAEMON_LEAF)

const SESSION_A = '0192a4b1-1111-4111-8111-aaaaaaaaaaaa'
const SESSION_B = '0192a4b1-2222-4222-8222-bbbbbbbbbbbb'
const UNPINNED_SESSION = '0192a4b1-9999-4999-8999-999999999999'

function buildDaemonHostedBody(sessionId: string, prompt: string): Record<string, unknown> {
  return {
    // The daemon worker's env, NOT the pane the user is typing in.
    paneKey: DAEMON_PANE,
    tabId: 'tab-daemon',
    worktreeId: 'wt-daemon',
    env: 'production',
    payload: {
      hook_event_name: 'UserPromptSubmit',
      prompt,
      session_id: sessionId
    }
  }
}

async function withServer(
  run: (server: AgentHookServer, post: (body: unknown) => Promise<number>) => Promise<void>
): Promise<void> {
  _internals.resetCachesForTests()
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    const env = server.buildPtyEnv()
    const post = async (body: unknown): Promise<number> => {
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(body)
      })
      return response.status
    }
    await run(server, post)
  } finally {
    server.stop()
  }
}

function panesInSnapshot(server: AgentHookServer): { paneKey: string; prompt?: string }[] {
  return server
    .getStatusSnapshot()
    .map((entry) => ({ paneKey: entry.paneKey, prompt: entry.prompt }))
}

describe('shared-daemon pane attribution (local hook path)', () => {
  it('routes a daemon-hosted turn to the pane the session was spawned into, not the inherited pane key', async () => {
    await withServer(async (server, post) => {
      server.bindAgentSessionPane('claude', SESSION_A, { paneKey: SPLIT_PANE_A, ptyId: 'pty-a' })

      expect(await post(buildDaemonHostedBody(SESSION_A, 'ship the fix'))).toBe(204)

      expect(panesInSnapshot(server)).toEqual([{ paneKey: SPLIT_PANE_A, prompt: 'ship the fix' }])
    })
  })

  it('re-files a corrected event under the workspace it was spawned in, not the daemon’s', async () => {
    await withServer(async (server, post) => {
      server.bindAgentSessionPane('claude', SESSION_A, {
        paneKey: SPLIT_PANE_A,
        ptyId: 'pty-a',
        worktreeId: 'wt-real'
      })

      expect(await post(buildDaemonHostedBody(SESSION_A, 'cross-workspace turn'))).toBe(204)

      // 'wt-daemon' is the daemon's inherited workspace and must not survive.
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: SPLIT_PANE_A, worktreeId: 'wt-real' })
      ])
    })
  })

  it('keeps two split panes in one tab on their own rows when both post the same inherited key', async () => {
    await withServer(async (server, post) => {
      server.bindAgentSessionPane('claude', SESSION_A, { paneKey: SPLIT_PANE_A, ptyId: 'pty-a' })
      server.bindAgentSessionPane('claude', SESSION_B, { paneKey: SPLIT_PANE_B, ptyId: 'pty-b' })

      expect(await post(buildDaemonHostedBody(SESSION_A, 'left pane work'))).toBe(204)
      expect(await post(buildDaemonHostedBody(SESSION_B, 'right pane work'))).toBe(204)

      // Without per-session binding both turns collapse onto DAEMON_PANE and the
      // second prompt clobbers the first.
      expect(panesInSnapshot(server).sort((a, b) => a.paneKey.localeCompare(b.paneKey))).toEqual([
        { paneKey: SPLIT_PANE_A, prompt: 'left pane work' },
        { paneKey: SPLIT_PANE_B, prompt: 'right pane work' }
      ])
    })
  })

  it('leaves an unpinned session on the pane it posted', async () => {
    await withServer(async (server, post) => {
      server.bindAgentSessionPane('claude', SESSION_A, { paneKey: SPLIT_PANE_A, ptyId: 'pty-a' })

      expect(await post(buildDaemonHostedBody(UNPINNED_SESSION, 'typed claude'))).toBe(204)

      // A hand-typed `claude` in a plain shell has no pin; today's behavior stands.
      expect(panesInSnapshot(server)).toEqual([{ paneKey: DAEMON_PANE, prompt: 'typed claude' }])
    })
  })

  it('stops re-routing once the pinning PTY exits', async () => {
    await withServer(async (server, post) => {
      server.bindAgentSessionPane('claude', SESSION_A, { paneKey: SPLIT_PANE_A, ptyId: 'pty-a' })
      server.clearAgentSessionPaneBindingsForPty('pty-a')

      expect(await post(buildDaemonHostedBody(SESSION_A, 'after pane closed'))).toBe(204)

      expect(panesInSnapshot(server)).toEqual([
        { paneKey: DAEMON_PANE, prompt: 'after pane closed' }
      ])
    })
  })

  it('does not let one agent binding capture another agent that reuses the session id', async () => {
    await withServer(async (server, post) => {
      // Same id, different hook source: bindings are source-scoped.
      server.bindAgentSessionPane('codex', SESSION_A, { paneKey: SPLIT_PANE_A, ptyId: 'pty-a' })

      expect(await post(buildDaemonHostedBody(SESSION_A, 'claude turn'))).toBe(204)

      expect(panesInSnapshot(server)).toEqual([{ paneKey: DAEMON_PANE, prompt: 'claude turn' }])
    })
  })

  it('refuses to bind a pane key the status pipeline cannot route', async () => {
    // Why #14018 reported an unroutable "$$<hash>:L$$" key: any key that is not
    // `<tabId>:<leafUuid>` is rejected at the hook boundary, so a binding must
    // never be able to introduce one.
    const remintedShape = '$$q7v2m9c4:L$$'
    expect(isValidPaneKey(remintedShape)).toBe(false)

    await withServer(async (server, post) => {
      server.bindAgentSessionPane('claude', SESSION_A, { paneKey: remintedShape, ptyId: 'pty-a' })

      expect(await post(buildDaemonHostedBody(SESSION_A, 'unroutable target'))).toBe(204)

      expect(panesInSnapshot(server)).toEqual([
        { paneKey: DAEMON_PANE, prompt: 'unroutable target' }
      ])
    })
  })
})

describe('shared-daemon pane attribution (relay path)', () => {
  it('routes a remote daemon-hosted turn to the spawn-pinned pane', () => {
    _internals.resetCachesForTests()
    const server = new AgentHookServer()
    server.bindAgentSessionPane('claude', SESSION_A, {
      paneKey: SPLIT_PANE_A,
      ptyId: 'pty-remote',
      worktreeId: 'wt-real'
    })

    const event = normalizeHookPayload(
      createHookListenerState(),
      'claude',
      buildDaemonHostedBody(SESSION_A, 'remote turn'),
      'production'
    )
    if (!event) {
      throw new Error('normalizeHookPayload rejected a known-good relay fixture')
    }
    expect(event.providerSession?.id).toBe(SESSION_A)
    server.ingestRemote({ ...event, source: 'claude' }, 'conn-1')

    expect(panesInSnapshot(server)).toEqual([{ paneKey: SPLIT_PANE_A, prompt: 'remote turn' }])
    // Why asserted here too: the relay seam has its own worktree override, and
    // 'wt-daemon' is the workspace the stale env named.
    expect(server.getStatusSnapshot()[0]?.worktreeId).toBe('wt-real')
  })
})

describe('an already-correct pane key', () => {
  it('is left alone rather than overwritten from the binding', async () => {
    // Why this matters beyond an early-out: the binding also carries a
    // worktreeId. A session that posts its own (correct) pane must not have its
    // workspace restamped from a binding recorded at spawn time.
    await withServer(async (server, post) => {
      server.bindAgentSessionPane('claude', SESSION_A, {
        paneKey: DAEMON_PANE,
        ptyId: 'pty-a',
        worktreeId: 'wt-at-spawn'
      })

      expect(await post(buildDaemonHostedBody(SESSION_A, 'posted its own pane'))).toBe(204)

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: DAEMON_PANE, worktreeId: 'wt-daemon' })
      ])
    })
  })
})

describe('readHookBodyProviderSessionId', () => {
  it('reads the id from both the object and JSON-string payload forms', () => {
    const body = buildDaemonHostedBody(SESSION_A, 'x')
    expect(readHookBodyProviderSessionId('claude', body)).toBe(SESSION_A)
    expect(
      readHookBodyProviderSessionId('claude', { ...body, payload: JSON.stringify(body.payload) })
    ).toBe(SESSION_A)
  })

  it('ignores a Codex child hook, whose session id belongs to the child not the pane', () => {
    expect(
      readHookBodyProviderSessionId('codex', {
        paneKey: DAEMON_PANE,
        payload: { session_id: SESSION_A, agent_id: 'child-1' }
      })
    ).toBeNull()
  })

  it('returns null for malformed payloads instead of throwing', () => {
    expect(readHookBodyProviderSessionId('claude', null)).toBeNull()
    expect(readHookBodyProviderSessionId('claude', { payload: '{not json' })).toBeNull()
    expect(readHookBodyProviderSessionId('claude', { payload: 7 })).toBeNull()
  })
})
