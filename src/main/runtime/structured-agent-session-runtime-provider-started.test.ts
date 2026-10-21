// A Claude child proving its start must not wait on another session's start, and must not make
// that start, or the session's own serialized operations, wait on the CLI: the host
// records what the child proved from what the adapter already holds.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForStructuredAgentSessionRecovery } from './structured-agent-session-runtime'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const STALLED = 'claude-started-stalled'
const HEALTHY = 'claude-started-healthy'
const CALLER = { callerKey: 'client-1' }

let claude = createScriptedClaudeRuntime([STALLED, HEALTHY])

afterEach(async () => {
  vi.restoreAllMocks()
  await claude.dispose()
  claude = createScriptedClaudeRuntime([STALLED, HEALTHY])
})

describe('a Claude child proving its start', () => {
  it("never holds another session's start, or its own close, on a CLI read", async () => {
    claude.behave(STALLED, { stallsControlReads: true })
    const host = await claude.install()

    await expect(host.attach(CALLER, claude.attachParams(HEALTHY, null))).resolves.toMatchObject({
      ok: true
    })
    await waitForStructuredAgentSessionRecovery()

    // This child answers startup, then never answers another control read.
    await expect(host.attach(CALLER, claude.attachParams(STALLED, null))).resolves.toMatchObject({
      ok: true
    })
    await vi.waitFor(() => expect(claude.child(STALLED).calls).toContain('get_settings'))
    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(STALLED)?.child?.phase).toBe('ready')
    )

    claude.child(HEALTHY).exit(new Error('claude stream-json exited (code 1): crashed'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(HEALTHY)?.lease.claimStatus).toBe('released')
    )

    // What the child proved is still recorded, from the startup it already answered.
    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(STALLED)?.child?.phase).toBe('ready')
    )
    expect(host.deps.store.getRecord(STALLED)?.options).toBeUndefined()
    expect(host.deps.store.getRecord(STALLED)?.providerHandleChain).toHaveLength(1)
    expect(claude.child(STALLED).calls).toEqual(['get_settings'])

    let closed = false
    void host.close(STALLED, 'evict').then(() => {
      closed = true
    })
    await vi.waitFor(() => expect(closed).toBe(true))
  })

  it("flips to ready while another session's start is still acquiring", async () => {
    const host = await claude.install()
    // This start never returns from its spawn, so its lease stays reserved with no child.
    claude.behave(HEALTHY, { spawnHangs: true })
    void host.attach(CALLER, claude.attachParams(HEALTHY, null)).catch(() => undefined)
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(HEALTHY)?.lease.claimStatus).toBe('reserved')
    )
    const childrenWhileHung = claude.children(HEALTHY).length

    await expect(host.attach(CALLER, claude.attachParams(STALLED, null))).resolves.toMatchObject({
      ok: true
    })
    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(STALLED)?.child?.phase).toBe('ready')
    )
    // The other start is still where it was: reserved, with no new child.
    expect(host.deps.store.getRecord(HEALTHY)?.lease.claimStatus).toBe('reserved')
    expect(claude.children(HEALTHY)).toHaveLength(childrenWhileHung)
  })

  it('records the proven start without overwriting saved choices with provider reports', async () => {
    const host = await claude.install()
    const replaceOptions = vi.spyOn(host.deps.store, 'replaceSessionOptions')
    const saved = { model: 'opus', effort: 'low' }
    await expect(
      host.attach(CALLER, claude.attachParams(HEALTHY, null, { options: saved }))
    ).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(host.collaboratorsForTests().sessions.get(HEALTHY)?.child?.phase).toBe('ready')
    )

    expect(host.deps.store.getRecord(HEALTHY)?.providerHandleChain).toHaveLength(1)
    expect(host.deps.store.getRecord(HEALTHY)?.options).toEqual(saved)
    expect(replaceOptions).not.toHaveBeenCalled()
  })
})
