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
    // Its `started` reaches the shared chain ahead of the exit below.
    await new Promise((resolve) => setImmediate(resolve))

    claude.child(HEALTHY).exit(new Error('claude stream-json exited (code 1): crashed'))
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(HEALTHY)?.lease.claimStatus).toBe('released')
    )

    // What the child proved is still recorded, from the startup it already answered.
    await vi.waitFor(() =>
      expect(host.deps.store.getRecord(STALLED)?.options).toEqual({
        model: 'claude-sonnet-5',
        effort: 'high'
      })
    )
    expect(claude.child(STALLED).calls).toEqual(['get_settings'])

    let closed = false
    void host.close(STALLED).then(() => {
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
      expect(host.deps.store.getRecord(STALLED)?.options).toEqual({
        model: 'claude-sonnet-5',
        effort: 'high'
      })
    )
    // The other start is still where it was: reserved, with no new child.
    expect(host.deps.store.getRecord(HEALTHY)?.lease.claimStatus).toBe('reserved')
    expect(claude.children(HEALTHY)).toHaveLength(childrenWhileHung)
  })

  it('is drained by the runtime before teardown proceeds', async () => {
    const host = await claude.install()
    const store = host.deps.store
    const replaceSessionOptions = store.replaceSessionOptions.bind(store)
    let landWrite = (): void => {}
    const writeHeld = new Promise<void>((resolve) => {
      landWrite = resolve
    })
    let writing = false
    vi.spyOn(store, 'replaceSessionOptions').mockImplementation(async (input) => {
      writing = true
      await writeHeld
      return replaceSessionOptions(input)
    })
    await expect(host.attach(CALLER, claude.attachParams(HEALTHY, null))).resolves.toMatchObject({
      ok: true
    })
    await vi.waitFor(() => expect(writing).toBe(true))

    let drained = false
    const recovery = waitForStructuredAgentSessionRecovery().then(() => {
      drained = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(drained).toBe(false)

    landWrite()
    await recovery
    expect(store.getRecord(HEALTHY)?.options).toEqual({ model: 'claude-sonnet-5', effort: 'high' })
  })
})
