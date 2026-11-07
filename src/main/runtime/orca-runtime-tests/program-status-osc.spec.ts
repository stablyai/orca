import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { committingSpawn } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { createSideEffectRuntime } from './orca-runtime-test-scenario-builders.spec'
import type { RuntimeTerminalAgentStatusEvent } from '../terminal/output/terminal-agent-status-events'
import {
  syncSinglePty,
  TEST_WORKTREE_PATH,
  expectStablePaneKeyEnv,
  store
} from './orca-runtime-test-fixtures.spec'
import { spawnedPtyEnv } from '../spawned-pty-env-fixtures'

describe('OSC 7501 program status', () => {
  it('projects split reports from a rendererless PTY into hook-yielding status events', async () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-ps' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'claude', title: 'w' })
    const paneKey = expectStablePaneKeyEnv(spawnedPtyEnv(spawn.mock.calls[0]?.[0]))

    const question = Buffer.from('answer: Tea or coffee?').toString('base64')
    runtime.onPtyData('pty-ps', 'x\x1b]7501;state=working:app=claude-code\x1b\\\x1b]75', 1)
    runtime.onPtyData(
      'pty-ps',
      `01;state=blocked:kind=question:app=claude-code:msg=${question}\x07`,
      2
    )

    expect(
      statuses.map((event) => [event.paneKey, event.fromProgramStatus, event.payload])
    ).toEqual([
      [paneKey, true, expect.objectContaining({ state: 'working', agentType: 'claude' })],
      [
        paneKey,
        true,
        expect.objectContaining({
          state: 'waiting',
          agentType: 'claude',
          toolInput: 'answer: Tea or coffee?'
        })
      ]
    ])
  })

  it("hands the store each chunk's facet before the rows that chunk publishes", async () => {
    const order: string[] = []
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-order' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => order.push(`status:${event.payload.state}`),
      onTerminalProgramStatusFacet: (event) => order.push(`facet:${event.facet?.state ?? 'none'}`)
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'brew', title: 'w' })

    runtime.onPtyData('pty-order', '\x1b]7501;state=working:app=brew:progress=10\x1b\\', 1)
    runtime.onPtyData('pty-order', '\x1b]7501;state=done:app=brew\x1b\\', 2)

    // Readers between status updates must never see done with a live facet.
    expect(order).toEqual(['facet:working', 'status:working', 'facet:done', 'status:done'])
  })

  it('clears a live facet when its PTY exits but keeps a finished one', async () => {
    const facets: [string, string | null][] = []
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-live' })
      .mockResolvedValueOnce({ id: 'pty-done' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalProgramStatusFacet: (event) =>
        facets.push([event.ptyId, event.facet?.state ?? null])
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'brew', title: 'a' })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'brew', title: 'b' })

    runtime.onPtyData('pty-live', '\x1b]7501;state=working:app=brew:progress=10\x1b\\', 1)
    runtime.onPtyData('pty-done', '\x1b]7501;state=done:app=brew\x1b\\', 1)
    await runtime.onPtyExit('pty-live', 0)
    await runtime.onPtyExit('pty-done', 0)

    expect(facets).toEqual([
      ['pty-live', 'working'],
      ['pty-done', 'done'],
      ['pty-live', null]
    ])
  })

  it("drives agent edges and the PTY's status from Claude's OSC 7501, not its glyph-less titles", () => {
    // Claude Code 2.1.302 drops title spinners after OSC 7501; only its program report distinguishes working from idle.
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)
    const osc7501 = (body: string) => `\x1b]7501;${body}\x1b\\`
    type PtyRecords = { ptysById: Map<string, { lastAgentStatus: string | null }> }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the runtime's own PTY record, which the public API does not expose.
    const records = runtime as unknown as PtyRecords
    const ptyStatus = () => records.ptysById.get('pty-1')?.lastAgentStatus

    runtime.onPtyData('pty-1', `${osc7501('state=idle:app=claude-code')}\x1b]0;Claude Code\x07`, 1)
    expect(ptyStatus()).toBe('idle')
    runtime.onPtyData('pty-1', osc7501('state=working:app=claude-code'), 2)
    expect(ptyStatus()).toBe('working')
    runtime.onPtyData('pty-1', '\x1b]0;Fix the parser\x07', 3)
    expect(ptyStatus()).toBe('working')
    runtime.onPtyData('pty-1', osc7501('state=done:app=claude-code'), 4)
    expect(ptyStatus()).toBe('idle')

    const edges = batches.flatMap((batch) =>
      batch.facts.filter((fact) => fact.kind === 'agent-working' || fact.kind === 'agent-idle')
    )
    expect(edges).toEqual([
      { kind: 'agent-working' },
      { kind: 'agent-idle', title: 'Fix the parser', status: 'idle' }
    ])
  })

  it("returns the PTY's status to its titles once the shell prompt follows a program's done", () => {
    const { runtime } = createSideEffectRuntime()
    syncSinglePty(runtime)
    const osc7501 = (body: string) => `\x1b]7501;${body}\x1b\\`
    type PtyRecords = {
      ptysById: Map<
        string,
        { lastAgentStatus: string | null; lastExplicitAgentStatus?: { programAtRest?: boolean } }
      >
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the runtime's own PTY record, which the public API does not expose.
    const records = runtime as unknown as PtyRecords
    const pty = () => records.ptysById.get('pty-1')

    runtime.onPtyData('pty-1', `\x1b]0;tf\x07${osc7501('state=done:app=terraform')}`, 1)
    expect(pty()?.lastAgentStatus).toBe('idle')
    expect(pty()?.lastExplicitAgentStatus?.programAtRest).toBe(true)
    runtime.onPtyData('pty-1', '\x1b]133;A\x07', 2)
    expect(pty()?.lastAgentStatus).toBeNull()
    expect(pty()?.lastExplicitAgentStatus?.programAtRest).toBeUndefined()
    runtime.onPtyData('pty-1', '\x1b]0;⠋ Gemini working\x07', 3)
    expect(pty()?.lastAgentStatus).toBe('working')
  })

  it('re-classifies on an activity change without restamping the last title', () => {
    const { runtime } = createSideEffectRuntime()
    syncSinglePty(runtime)
    type PtyRecords = {
      ptysById: Map<string, { lastAgentStatus: string | null; lastOscTitleAt: number | null }>
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the runtime's own PTY record, which the public API does not expose.
    const records = runtime as unknown as PtyRecords
    const pty = () => records.ptysById.get('pty-1')

    runtime.onPtyData('pty-1', '\x1b]0;Fix the parser\x07', 1)
    const titledAt = pty()?.lastOscTitleAt
    runtime.onPtyData('pty-1', '\x1b]7501;state=working:app=claude-code\x1b\\', 2)
    expect(pty()?.lastAgentStatus).toBe('working')
    expect(pty()?.lastOscTitleAt).toBe(titledAt)
  })

  it("classifies a chunk's trailing glyph-less title by the program's activity for the prompt lifecycle", () => {
    const { runtime } = createSideEffectRuntime()
    syncSinglePty(runtime)
    type Lifecycle = { agentPromptLifecycleByPtyId: Map<string, { status: string | null }> }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the runtime's own lifecycle map, which the public API does not expose.
    const lifecycle = runtime as unknown as Lifecycle
    runtime.onPtyData(
      'pty-1',
      '\x1b]7501;state=working:app=claude-code\x1b\\\x1b]0;Fix the parser\x07',
      1
    )
    expect(lifecycle.agentPromptLifecycleByPtyId.get('pty-1')?.status).toBe('working')
  })

  it('reports a lasting sign-in block as blocked instead of waiting out tui-idle (#37056, #28348)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    vi.setSystemTime(1_000_000)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agy' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'agy',
      title: 'w'
    })
    const signIn = Buffer.from('Sign in required').toString('base64')
    // agy 1.5.2's bytes at its "Select login method" menu.
    runtime.onPtyData(
      'pty-agy',
      `\x1b]7501;state=blocked:kind=auth:app=antigravity:msg=${signIn}\x07Select login method:\r\n> 1. Google OAuth\r\n`,
      Date.now()
    )
    // agy flashes this at startup before signing itself in, so a fresh block is not yet final.
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).rejects.toThrow('timeout')

    vi.setSystemTime(1_003_001)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-sign-in-prompt' })

    runtime.onPtyData('pty-agy', '\x1b]7501;state=idle:app=antigravity\x07', Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({ satisfied: true })
  })
})
