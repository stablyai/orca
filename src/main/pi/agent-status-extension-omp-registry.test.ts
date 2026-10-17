import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { AgentHookServer } from '../agent-hooks/server'
import { buildBody, PANE } from '../agent-hooks/server.test-fixtures'
import {
  NATIVE_TIME,
  createNativeFixture,
  nativeChild,
  nativeRoot,
  type DeliveredPost,
  type NativeRef,
  type NativeRoot
} from './agent-status-extension-omp-registry-fixture'
import type { HookContext } from './agent-status-extension-test-harness'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

function snapshot(posts: DeliveredPost[]): DeliveredPost {
  const post = posts.findLast(({ payload }) => payload.hook_event_name === 'subagents_update')
  if (!post) {
    throw new Error('Expected a verified native snapshot')
  }
  return post
}

// Only the freshness and human-input cases need host-owned clocks.
function createNativeConsumer(root: NativeRoot, children: NativeRef[] = []) {
  const server = new AgentHookServer()
  const fixture = createNativeFixture(root, children, {
    env: {
      ORCA_AGENT_HOOK_ENV: 'production',
      ORCA_PANE_KEY: PANE,
      ORCA_AGENT_LAUNCH_TOKEN: undefined
    },
    delivery: async (payload) => {
      const event = normalizeHookPayload(
        server._getStateForTests(),
        'omp',
        buildBody(payload),
        'production'
      )
      if (event) {
        server.ingestRemote(event, null)
      }
      return { ok: true }
    }
  })
  return {
    ...fixture,
    server,
    consume: () => server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)!
  }
}

describe('OMP native registry guarantees', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NATIVE_TIME)
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('discovers named missed starts and refreshes quiet evidence without inventing a root turn', async () => {
    const root = nativeRoot('quiet-root')
    const children = [nativeChild('NamedLeft', root.file), nativeChild('NamedRight', root.file)]
    const { harness, delivered, consume, server } = createNativeConsumer(root, children)
    try {
      await harness.callHook('session_start', { reason: 'startup' }, root.context)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(snapshot(delivered).payload).toMatchObject({
        omp_status: { state: 'done', session_boundary: true },
        subagents: children.map((child) =>
          expect.objectContaining({
            id: child.id,
            description: child.id,
            startedAt: child.createdAt
          })
        )
      })
      const initial = consume()
      expect(initial).toMatchObject({ state: 'working', mainAgent: { state: 'done' } })
      expect(initial.turnStartedAt).toBeUndefined()

      await vi.advanceTimersByTimeAsync(12_000)
      const quiet = consume()
      expect(quiet.receivedAt).toBeGreaterThan(initial.receivedAt)
      expect(quiet.stateStartedAt).toBe(initial.stateStartedAt)
      expect(quiet.mainAgent?.stateStartedAt).toBe(initial.mainAgent?.stateStartedAt)
      expect(quiet.turnStartedAt).toBeUndefined()
    } finally {
      await harness.callHook('session_shutdown', { reason: 'quit' }, root.context)
      server.stop()
    }
  })

  it('holds completion for hidden async work through SDK idle stamps, resume and settlement', async () => {
    const root = nativeRoot('async-root')
    let rootPending = true
    root.ref.status = 'idle'
    root.session.hasPendingAsyncWork = () => rootPending
    const children = Array.from({ length: 33 }, (_, index) =>
      nativeChild(`Child${index}`, root.file)
    )
    const fixture = createNativeFixture(root, children)
    const { harness, delivered } = fixture
    try {
      await harness.callHook('session_start', {}, root.context)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(snapshot(delivered).payload.omp_status?.state).toBe('working')
      const shown = snapshot(delivered).payload.subagents!.map(({ id }) => id)
      expect(shown).toHaveLength(32)
      const hidden = children.find(({ id }) => !shown.includes(id))!
      let childPending = true
      hidden.session.hasPendingAsyncWork = () => childPending
      await harness.callHook('agent_start', {}, root.context)
      rootPending = false
      await harness.callHook('agent_end', {}, root.context)
      for (const child of children) {
        fixture.setStatus(child, 'idle')
      }
      // Real SDK running -> idle stamps terminalAt even when async work remains.
      expect(hidden.lifecycle?.terminalAt).toBe(Date.now())
      await vi.advanceTimersByTimeAsync(6_000)
      expect(delivered.some(({ payload }) => payload.hook_event_name === 'agent_end')).toBe(false)
      expect(snapshot(delivered).payload).toMatchObject({
        omp_status: { state: 'done' },
        subagents: [expect.objectContaining({ id: hidden.id, state: 'working' })]
      })

      childPending = false
      hidden.session.isStreaming = true
      fixture.setStatus(hidden, 'running')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(snapshot(delivered).payload.subagents).toHaveLength(1)
      fixture.setStatus(hidden, 'idle')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(snapshot(delivered).payload.subagents).toEqual([])
      expect(
        delivered.find(({ payload }) => payload.hook_event_name === 'agent_end')?.payload
      ).toMatchObject({ session_id: 'async-root', session_file: root.file })
    } finally {
      await harness.callHook('session_shutdown', { reason: 'quit' }, root.context)
    }
  })

  it('seeds an untouched root as working only after a positive native recovery', async () => {
    const root = nativeRoot('unreadable-root')
    let unavailable = true
    root.session.hasPendingAsyncWork = () => {
      if (unavailable) {
        throw new Error('Native execution unavailable')
      }
      return true
    }
    const { harness, delivered } = createNativeFixture(root, [])
    try {
      await harness.callHook('session_start', {}, root.context)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(delivered).toEqual([])
      unavailable = false
      await vi.advanceTimersByTimeAsync(6_000)
      expect(snapshot(delivered).payload.omp_status).toEqual({
        state: 'working',
        session_boundary: true
      })
    } finally {
      await harness.callHook('session_shutdown', { reason: 'quit' }, root.context)
    }
  })

  it('restores asks and pending approval without clobbering the prompt or wait clocks', async () => {
    const root = nativeRoot('human-wait-root', true)
    root.context.hasUI = true
    const { harness, consume, server } = createNativeConsumer(root)
    const questions = { questions: [{ id: 'scope', question: 'Which scope?' }] }
    const reason = 'Allow workspace inspection?'
    try {
      await harness.callHook('session_start', {}, root.context)
      await vi.advanceTimersByTimeAsync(1_000)
      await harness.callHook('before_agent_start', { prompt: 'Inspect scope.' }, root.context)
      await harness.callHook('agent_start', {}, root.context)
      await harness.callHook(
        'tool_execution_start',
        { toolName: 'ask', args: questions },
        root.context
      )
      await harness.callHook('tool_approval_requested', { toolName: 'bash', reason }, root.context)
      await vi.advanceTimersByTimeAsync(1_000)
      const asking = consume()
      expect(asking).toMatchObject({
        state: 'blocked',
        prompt: 'Inspect scope.',
        toolName: 'ask',
        interactivePrompt: JSON.stringify(questions)
      })
      expect(asking.turnStartedAt).toEqual(expect.any(Number))

      harness.reload()
      await harness.callHook('session_start', { reason: 'reload' }, root.context)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(consume()).toMatchObject({
        state: 'blocked',
        toolName: 'ask',
        interactivePrompt: asking.interactivePrompt,
        prompt: asking.prompt,
        stateStartedAt: asking.stateStartedAt,
        turnStartedAt: asking.turnStartedAt
      })
      await harness.callHook('tool_execution_end', { toolName: 'ask' }, root.context)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(consume()).toMatchObject({
        state: 'blocked',
        toolName: 'bash',
        toolInput: reason,
        turnStartedAt: asking.turnStartedAt
      })
      expect(consume().interactivePrompt).toBeUndefined()
      await harness.callHook(
        'tool_approval_resolved',
        { toolName: 'bash', approved: true },
        root.context
      )
      await vi.advanceTimersByTimeAsync(1_000)
      expect(consume()).toMatchObject({
        state: 'working',
        prompt: asking.prompt,
        turnStartedAt: asking.turnStartedAt
      })
    } finally {
      await harness.callHook('session_shutdown', { reason: 'quit' }, root.context)
      server.stop()
    }
  })

  it('rebinds a replaced scope while fencing foreign children, child factories and old callbacks', async () => {
    const before = nativeRoot('before-root', true)
    const oldChild = nativeChild('OldWorker', before.file)
    const fixture = createNativeFixture(before, [oldChild])
    const { harness, delivered } = fixture
    const after = nativeRoot('after-root', true)
    const replacement = harness.registerTaskChild()
    const childFactory = harness.registerTaskChild()
    const childContext: HookContext = {
      agent: { id: oldChild.id, kind: 'sub', parentId: 'Main', depth: 1 },
      sessionManager: oldChild.session.sessionManager
    }
    try {
      await harness.callHook('session_start', {}, before.context)
      await harness.callHook('before_agent_start', { prompt: 'Old scope only.' }, before.context)
      await vi.advanceTimersByTimeAsync(1_000)
      const verified = snapshot(delivered)
      await childFactory.callHook('session_start', {}, childContext)
      // A Main label cannot replace the native session-manager ownership proof.
      await childFactory.callHook('session_start', {}, after.context)
      await childFactory.callHook('session_shutdown', {}, after.context)
      expect(snapshot(delivered)).toBe(verified)
      const staleCallback = fixture.captureNotification()
      const ancestor = nativeChild('IdleAncestor', after.file)
      ancestor.status = 'idle'
      ancestor.session.isStreaming = false
      const child = nativeChild('CurrentWorker', ancestor.sessionFile)
      child.parentId = ancestor.id
      const foreign = nativeChild('ForeignWorker', after.file)
      foreign.parentId = 'OtherMain'
      for (const ref of [after.ref, ancestor, child, foreign]) {
        fixture.refs.set(ref.id, ref)
      }
      staleCallback('metadata_changed', oldChild)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(snapshot(delivered)).toBe(verified)

      await replacement.callHook('session_start', {}, after.context)
      await vi.advanceTimersByTimeAsync(1_000)
      const rebound = snapshot(delivered)
      expect(rebound.payload).toMatchObject({
        session_id: 'after-root',
        session_file: after.file,
        subagents: [expect.objectContaining({ id: child.id })]
      })
      expect(rebound.payload.omp_status).not.toHaveProperty('prompt')
      await harness.callHook('session_shutdown', {}, before.context)
      await childFactory.callHook('session_shutdown', {}, childContext)
      staleCallback('registered', oldChild)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(snapshot(delivered).observedAt).toBeGreaterThan(rebound.observedAt)
      expect(snapshot(delivered).payload.session_id).toBe('after-root')
      expect(snapshot(delivered).payload.subagents).toEqual(rebound.payload.subagents)
    } finally {
      await replacement.callHook('session_shutdown', { reason: 'quit' }, after.context)
    }
  })

  it('cannot refresh or empty failed reads and recovers a silent native attachment', async () => {
    const root = nativeRoot('uncertain-root', true)
    const first = nativeChild('PreviouslyVerified', root.file)
    const fixture = createNativeFixture(root, [first])
    const { harness, delivered } = fixture
    try {
      await harness.callHook('session_start', {}, root.context)
      await harness.callHook('agent_start', {}, root.context)
      await vi.advanceTimersByTimeAsync(1_000)
      root.session.isStreaming = false
      await harness.callHook('agent_end', {}, root.context)
      await vi.advanceTimersByTimeAsync(1_000)
      const verified = snapshot(delivered)
      fixture.failList(new Error('Native enumeration unavailable'))
      fixture.setStatus(first, 'idle')
      await vi.advanceTimersByTimeAsync(12_000)
      expect(snapshot(delivered)).toBe(verified)
      expect(delivered.some(({ payload }) => payload.hook_event_name === 'agent_end')).toBe(false)

      fixture.failList()
      const attaching: NativeRef = nativeChild('Attaching', root.file)
      const session = attaching.session!
      const file = attaching.sessionFile
      attaching.session = null
      attaching.sessionFile = ''
      fixture.refs.set(attaching.id, attaching)
      fixture.notify('registered', attaching)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(snapshot(delivered)).toBe(verified)
      // Native attachSession emits no registry notification.
      attaching.session = session
      attaching.sessionFile = file
      await vi.advanceTimersByTimeAsync(6_000)
      expect(snapshot(delivered).observedAt).toBeGreaterThan(verified.observedAt)
      expect(snapshot(delivered).payload.subagents).toEqual([
        expect.objectContaining({ id: attaching.id, state: 'working' })
      ])
      fixture.setStatus(attaching, 'idle')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(snapshot(delivered).payload.subagents).toEqual([])
      expect(delivered.find(({ payload }) => payload.hook_event_name === 'agent_end')).toBeDefined()
    } finally {
      await harness.callHook('session_shutdown', { reason: 'quit' }, root.context)
    }
  })
})
