import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'

import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  closeTestAgentSessionRecordStores,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import type { AgentSessionReserveRequest } from '../ownership/agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

let directory: string
let counter = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-tab-table-'))
})

afterEach(async () => {
  await closeTestAgentSessionRecordStores()
  await rm(directory, { recursive: true, force: true })
})

function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

async function open(): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory)
}

describe('chat tab table', () => {
  it('keeps an ended chat ended across a restart, until it is shown again', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest())
    await store.setSessionTabVisibility('session-alpha', false, undefined, { background: true })
    await store.setSessionTabVisibility('session-alpha', false, undefined, { end: true })
    expect(store.isSessionEnded('session-alpha')).toBe(true)
    expect(store.isSessionInBackground('session-alpha')).toBe(false)

    const reopened = await open()
    expect(reopened.isSessionEnded('session-alpha')).toBe(true)
    expect(reopened.isSessionInBackground('session-alpha')).toBe(false)

    await reopened.setSessionTabVisibility('session-alpha', true)
    expect(reopened.isSessionEnded('session-alpha')).toBe(false)
    expect((await open()).isSessionEnded('session-alpha')).toBe(false)
  })

  it("names a restored tab's showing once, renews it on every show and drops it on hide", async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest())
    await store.setSessionTabVisibility('session-alpha', true)

    // A restart restores the listed tab with no showing yet; the first read names it, later reads keep it.
    const reopened = await open()
    const restored = reopened.getSessionTabShowing('session-alpha')
    expect(restored).toEqual(expect.any(String))
    expect(reopened.getSessionTabShowing('session-alpha')).toBe(restored)

    // Showing a tab that is already listed is a new showing; an x on the old one is late.
    await reopened.setSessionTabVisibility('session-alpha', true)
    const renewed = reopened.getSessionTabShowing('session-alpha')
    expect(renewed).not.toBe(restored)
    expect(reopened.getSessionTabShowing('session-alpha')).toBe(renewed)

    await reopened.setSessionTabVisibility('session-alpha', false, undefined, { background: true })
    expect(reopened.getSessionTabShowing('session-alpha')).toBeNull()
  })

  it("keeps a listed tab's showing through a publish that opens nothing new", async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest())
    await store.setSessionTabVisibility('session-alpha', true)
    const shown = store.getSessionTabShowing('session-alpha')

    // An automation reusing the chat publishes it without activating: no client hears of it.
    await store.setSessionTabVisibility('session-alpha', true, undefined, { keepShowing: true })
    expect(store.getSessionTabShowing('session-alpha')).toBe(shown)

    // Hidden in between, the same publish shows it anew, under a new name.
    await store.setSessionTabVisibility('session-alpha', false, undefined, { background: true })
    await store.setSessionTabVisibility('session-alpha', true, undefined, { keepShowing: true })
    const again = store.getSessionTabShowing('session-alpha')
    expect(again).toEqual(expect.any(String))
    expect(again).not.toBe(shown)
  })

  it('gives a hidden tab one showing when two publishes that open nothing new queue back to back', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest())
    await store.setSessionTabVisibility('session-alpha', false, undefined, { background: true })

    const named: (string | null)[] = []
    const show = () =>
      store.setSessionTabVisibility('session-alpha', true, undefined, {
        keepShowing: true,
        capture: () => named.push(store.getSessionTabShowing('session-alpha'))
      })
    await Promise.all([show(), show()])

    expect(named).toHaveLength(2)
    expect(named[1]).toBe(named[0])
    expect(store.getSessionTabShowing('session-alpha')).toBe(named[0])
  })
})
