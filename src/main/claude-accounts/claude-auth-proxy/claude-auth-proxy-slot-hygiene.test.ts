import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPty, unregisterPty } from '../../memory/pty-registry'
import {
  _internals,
  forgetClaudePaneAccount,
  recordClaudePaneAccount
} from '../claude-pane-account-registry'
import {
  claudeAuthProxyStatus,
  getClaudeAuthProxy,
  startClaudeAuthProxy,
  stopClaudeAuthProxy
} from './claude-auth-proxy-host'
import {
  dropUnboundAuthProxySlot,
  releaseSupersededOwnProxySlot,
  retainAppliedClaudeAuthProxySlot
} from './claude-auth-proxy-slot-env'
import {
  bindClaudeAuthProxySlotToPty,
  claudeAuthProxySlotOwner,
  claudeAuthProxySlotShouldPrune,
  CLAUDE_AUTH_PROXY_UNBOUND_SLOT_GRACE_MS,
  noteClaudeAuthProxySlotAllocated,
  resetClaudeAuthProxySlotOwners
} from './claude-auth-proxy-slot-owners'

const registered: string[] = []
/** A fixed clock: the status prune compares allocation times against Date.now(). */
const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const STALE_ALLOCATED_AT = NOW - CLAUDE_AUTH_PROXY_UNBOUND_SLOT_GRACE_MS - 1

function trackPty(ptyId: string): void {
  registerPty({ ptyId, worktreeId: null, sessionId: null, paneKey: null, pid: null })
  registered.push(ptyId)
}

function requireProxy(): NonNullable<ReturnType<typeof getClaudeAuthProxy>> {
  const proxy = getClaudeAuthProxy()
  if (!proxy || proxy.port() === null) {
    throw new Error('proxy did not start')
  }
  return proxy
}

afterEach(async () => {
  vi.useRealTimers()
  for (const ptyId of registered.splice(0)) {
    unregisterPty(ptyId)
  }
  forgetClaudePaneAccount('pty-pane')
  _internals.reset()
  resetClaudeAuthProxySlotOwners()
  await stopClaudeAuthProxy()
})

describe('claude auth proxy slot owners', () => {
  it('drops an untracked slot, a dead PTY, and an unbound slot past the grace', () => {
    const now = 10_000
    expect(claudeAuthProxySlotShouldPrune('missing', new Set(), now)).toBe(true)
    noteClaudeAuthProxySlotAllocated('fresh', now)
    expect(
      claudeAuthProxySlotShouldPrune(
        'fresh',
        new Set(),
        now + CLAUDE_AUTH_PROXY_UNBOUND_SLOT_GRACE_MS
      )
    ).toBe(false)
    expect(
      claudeAuthProxySlotShouldPrune(
        'fresh',
        new Set(),
        now + CLAUDE_AUTH_PROXY_UNBOUND_SLOT_GRACE_MS + 1
      )
    ).toBe(true)
    bindClaudeAuthProxySlotToPty('held', 'pty-1', now)
    expect(claudeAuthProxySlotShouldPrune('held', new Set(['pty-1']), now + 99_000)).toBe(false)
    expect(claudeAuthProxySlotShouldPrune('held', new Set(), now + 99_000)).toBe(true)
  })
})

describe('claudeAuthProxyStatus slot prune', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
    await startClaudeAuthProxy()
  })

  it('drops leaked slots and keeps a live PTY, a fresh unbound slot, and a pane record', () => {
    const proxy = requireProxy()
    const port = proxy.port()
    const leaked = proxy.allocateSlot('leaked')
    const stale = proxy.allocateSlot('stale')
    noteClaudeAuthProxySlotAllocated(stale, STALE_ALLOCATED_AT)
    const fresh = proxy.allocateSlot('fresh')
    noteClaudeAuthProxySlotAllocated(fresh)
    const live = proxy.allocateSlot('live')
    bindClaudeAuthProxySlotToPty(live, 'pty-live')
    trackPty('pty-live')
    const dead = proxy.allocateSlot('dead')
    bindClaudeAuthProxySlotToPty(dead, 'pty-dead')
    const referenced = proxy.allocateSlot('referenced')
    recordClaudePaneAccount({
      ptyId: 'pty-pane',
      paneKey: null,
      accountId: 'referenced',
      configDir: null,
      launchedAt: 1,
      pinned: false,
      source: 'spawn',
      proxySlot: referenced
    })
    resetClaudeAuthProxySlotOwners()
    bindClaudeAuthProxySlotToPty(live, 'pty-live')
    bindClaudeAuthProxySlotToPty(dead, 'pty-dead')
    noteClaudeAuthProxySlotAllocated(fresh)
    noteClaudeAuthProxySlotAllocated(stale, STALE_ALLOCATED_AT)

    const slots = claudeAuthProxyStatus().slots.map((entry) => entry.slot)
    expect(slots).toContain(fresh)
    expect(slots).toContain(live)
    expect(slots).toContain(referenced)
    expect(slots).not.toContain(leaked)
    expect(slots).not.toContain(stale)
    expect(slots).not.toContain(dead)
    expect(claudeAuthProxySlotOwner(referenced)?.ptyId).toBe('pty-pane')

    const terminal = proxy.allocateSlot('terminal')
    noteClaudeAuthProxySlotAllocated(terminal)
    const launch = proxy.allocateSlot('launch')
    noteClaudeAuthProxySlotAllocated(launch)
    expect(
      releaseSupersededOwnProxySlot(
        `http://127.0.0.1:${port}/p/${terminal}/`,
        `http://127.0.0.1:${port}/p/${launch}/`
      )
    ).toBe(true)
    expect(proxy.accountIdForSlot(terminal)).toBeNull()
    expect(proxy.accountIdForSlot(launch)).toBe('launch')
    expect(
      releaseSupersededOwnProxySlot(
        'https://gateway.example',
        `http://127.0.0.1:${port}/p/${launch}/`
      )
    ).toBe(false)

    const poll = proxy.allocateSlot('poll')
    noteClaudeAuthProxySlotAllocated(poll)
    const polled = dropUnboundAuthProxySlot({
      configDir: '/poll',
      envPatch: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/p/${poll}/` },
      provenance: 'profile:poll'
    })
    expect(polled.envPatch.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(proxy.accountIdForSlot(poll)).toBeNull()

    const shell = proxy.allocateSlot('shell')
    noteClaudeAuthProxySlotAllocated(shell)
    retainAppliedClaudeAuthProxySlot({
      ptyId: 'pty-shell',
      env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/p/${shell}/` },
      isReattach: false
    })
    expect(claudeAuthProxySlotOwner(shell)?.ptyId).toBe('pty-shell')
    const reattach = proxy.allocateSlot('reattach')
    noteClaudeAuthProxySlotAllocated(reattach)
    retainAppliedClaudeAuthProxySlot({
      ptyId: 'pty-reattach',
      env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/p/${reattach}/` },
      isReattach: true
    })
    expect(proxy.accountIdForSlot(reattach)).toBeNull()
  })
})
