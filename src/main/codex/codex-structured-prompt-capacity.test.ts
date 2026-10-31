import { describe, expect, it, vi } from 'vitest'
import {
  acquireReadyCodexForTest,
  THREAD_ID,
  adapterFor,
  fakeCodex,
  identityFor,
  lifecycleRecorder
} from './codex-structured-session-adapter-fixture'
import { CodexPromptRegistry } from './codex-prompt-registry'
import * as bounds from './codex-prompt-registry-bounds'
import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import {
  attach,
  CALLER,
  envelope,
  hostTestState
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

async function journalHarness(constrainedSink = false) {
  const state = hostTestState()
  await attach()
  const codex = fakeCodex()
  const adapter = adapterFor(codex, { resumeThreadId: HOST_TEST_THREAD })
  const fence = state.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
  const journal = state.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
  const deferred = createDeferredStructuredAgentSessionEventSink({
    sessionId: HOST_TEST_SESSION,
    logger: state.log.logger,
    ...(constrainedSink
      ? {
          watermarks: {
            maxQueuedOperations: 0,
            maxLifecycleQueuedOperations: 8,
            pauseQueuedBytes: 16_000,
            lowQueuedBytes: 0,
            lowQueuedOperations: 0
          }
        }
      : {})
  })
  const published: ReturnType<typeof journal.snapshot>[] = []
  const target = {
    journal,
    fence,
    publish: () => {
      published.push(journal.snapshot())
    }
  }
  deferred?.bind(target)
  let paused = false
  let registry: CodexPromptRegistry | undefined
  const ids: string[] = []
  const captureRegistry = (value: CodexPromptRegistry) => {
    registry = value
  }
  const original = CodexPromptRegistry.prototype.bindJournalItemId
  const binding = vi
    .spyOn(CodexPromptRegistry.prototype, 'bindJournalItemId')
    .mockImplementation(function (this: CodexPromptRegistry, ...args) {
      captureRegistry(this)
      original.apply(this, args)
      ids.push(args[0])
    })
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor(HOST_TEST_SESSION),
    fence,
    spawnToken: 'spawn-a',
    events: deferred?.sink ?? state.acquire.mock.calls.at(-1)![0].events
  })
  await deferred?.drained()
  state.answerPrompt.mockImplementation((input) => adapter.answerPrompt(input))
  const deliver = async (
    id: number,
    kind: 'approval' | 'questions' | 'form',
    count = 1,
    turnId = 'turn-1',
    optionText = 'yes',
    questions?: {
      id: string
      header: string
      question: string
      options: { label: string; description: string }[]
    }[]
  ) => {
    const before = ids.length
    const params =
      kind === 'questions'
        ? {
            itemId: `request-${id}`,
            questions:
              questions ??
              Array.from({ length: count }, (_, i) => ({
                id: `q${i}`,
                header: `Question ${i}`,
                question: `Question ${i}?`,
                options: [
                  { label: optionText },
                  ...(optionText === 'yes' ? [] : [{ label: 'Other', isOther: true }])
                ]
              }))
          }
        : kind === 'form'
          ? {
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: Object.fromEntries(
                  Array.from({ length: count }, (_, i) => [`f${i}`, { type: 'string' }])
                ),
                required: []
              }
            }
          : { itemId: `request-${id}` }
    codex.connections[0].handlers.onServerRequest?.({
      id,
      method:
        kind === 'questions'
          ? 'item/tool/requestUserInput'
          : kind === 'form'
            ? 'mcpServer/elicitation/request'
            : 'item/commandExecution/requestApproval',
      params: { ...params, threadId: HOST_TEST_THREAD, turnId }
    })
    await state.host.flushStreamedEvents(HOST_TEST_SESSION)
    if (!paused) {
      await deferred?.drained()
    }
    return { ids: [...new Set(ids.slice(before))] }
  }
  const answer = async (itemId: string, other?: string) => {
    const item = journal.snapshot().items.find((item) => item.itemId === itemId)
    if (!item || (item.body.kind !== 'question' && item.body.kind !== 'approval')) {
      throw new Error('Missing durable prompt')
    }
    const fields = {
      itemId,
      expectedRevision: item.revision,
      ...(item.body.kind === 'question'
        ? {
            answers: [
              {
                questionId: item.body.freeTextQuestionId ?? 'q1',
                optionIds: other === undefined ? [item.body.options[0]!.id] : [],
                ...(other === undefined ? {} : { other })
              }
            ]
          }
        : item.body.form
          ? { content: {} }
          : { optionId: 'accept' })
    }
    const result = await state.host.respondToPrompt(CALLER, {
      ...fields,
      kind: item.body.kind,
      envelope: envelope(`agentSession.respondTo:${item.body.kind}`, fields)
    })
    expect(result.ok).toBe(true)
    expect(journal.itemBody(itemId)).toMatchObject({ resolution: { state: 'resolved' } })
  }
  return {
    codex,
    journal,
    published,
    deliver,
    answer,
    deferred,
    pause: () => {
      paused = true
      deferred?.unbind()
    },
    resume: async () => {
      paused = false
      deferred?.bind(target)
      await deferred?.drained()
    },
    registry: () => {
      if (!registry) {
        throw new Error('No registry')
      }
      return registry
    },
    dispose: async () => {
      binding.mockRestore()
      await adapter.closeAll()
      deferred?.bind(target)
      await deferred?.drained()
      deferred?.close()
    }
  }
}

async function harness() {
  let registry: CodexPromptRegistry | undefined
  const captureRegistry = (value: CodexPromptRegistry) => {
    registry = value
  }
  const original = CodexPromptRegistry.prototype.bindJournalItemId
  const binding = vi
    .spyOn(CodexPromptRegistry.prototype, 'bindJournalItemId')
    .mockImplementation(function (this: CodexPromptRegistry, ...args) {
      captureRegistry(this)
      original.apply(this, args)
    })
  const codex = fakeCodex()
  const recorded = lifecycleRecorder()
  const adapter = adapterFor(codex)
  await acquireReadyCodexForTest(adapter, {
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recorded.sink
  })
  const deliver = (
    id: number,
    kind: 'approval' | 'questions' | 'form',
    count = 1,
    turnId = 'turn-1'
  ) => {
    const before = new Set(recorded.bodies.keys())
    const params =
      kind === 'questions'
        ? {
            itemId: `request-${id}`,
            questions: Array.from({ length: count }, (_, i) => ({
              id: `q${i}`,
              question: `Question ${i}?`,
              options: [{ label: 'yes' }]
            }))
          }
        : kind === 'form'
          ? {
              mode: 'form',
              message: 'Enter values',
              requestedSchema: {
                type: 'object',
                properties: Object.fromEntries(
                  Array.from({ length: count }, (_, i) => [`f${i}`, { type: 'string' }])
                ),
                required: []
              }
            }
          : { itemId: `request-${id}` }
    const request = {
      id,
      method:
        kind === 'questions'
          ? 'item/tool/requestUserInput'
          : kind === 'form'
            ? 'mcpServer/elicitation/request'
            : 'item/commandExecution/requestApproval',
      params: { ...params, threadId: THREAD_ID, turnId }
    }
    codex.connections[0].handlers.onServerRequest?.(request)
    return { request, ids: [...recorded.bodies.keys()].filter((id) => !before.has(id)) }
  }
  const answer = async (
    id: string,
    response?: AgentSessionPromptResponse,
    commit = async () => {}
  ) => {
    const body = recorded.bodies.get(id)
    if (!body || (body.kind !== 'question' && body.kind !== 'approval')) {
      throw new Error('Missing prompt')
    }
    const chosen: AgentSessionPromptResponse =
      response ??
      (body.kind === 'question'
        ? {
            kind: 'answers',
            answers: [
              { questionId: body.freeTextQuestionId ?? 'q1', optionIds: [body.options[0]!.id] }
            ]
          }
        : body.form
          ? { kind: 'form', content: {} }
          : { kind: 'option', optionId: 'accept' })
    await adapter.answerPrompt({
      sessionId: 'session-1',
      fence: 7,
      itemId: id,
      kind: body.kind,
      response: chosen,
      commit: async () => {
        await commit()
        recorded.bodies.set(id, {
          ...body,
          resolution: {
            state: 'resolved',
            selectedOptionId: chosen.kind === 'option' ? chosen.optionId : null,
            resolvedBy: 'test',
            resolvedAt: 1
          }
        })
      }
    })
  }
  return {
    codex,
    recorded,
    adapter,
    deliver,
    answer,
    registry: () => {
      if (!registry) {
        throw new Error('No registry')
      }
      return registry
    },
    dispose: () => binding.mockRestore()
  }
}

describe('whole incoming prompt obligations', () => {
  it.each([false, true])(
    'completes original ID0 repeated questions with ordered revisions and unique partial ownership (mixed=%s)',
    async (mixed) => {
      const h = await journalHarness()
      try {
        const question = (id: string, text: string, labels: string[]) => ({
          id,
          header: text,
          question: text,
          options: labels.map((label) => ({ label, description: label }))
        })
        const questions = [
          question('pick', 'First?', ['A', 'B']),
          question('pick', 'Later?', ['C', 'D']),
          ...(mixed ? [question('other', 'Other?', ['E', 'F'])] : [])
        ]
        const commits = vi.fn()
        const unobserve = h.journal.observeCommits(commits)
        const publications = h.published.length
        const batch = await h.deliver(0, 'questions', questions.length, 'turn-1', 'yes', questions)
        expect(commits).toHaveBeenCalledOnce()
        expect(h.published.slice(publications)).toHaveLength(1)
        expect(h.published.at(-1)).toEqual(h.journal.snapshot())
        expect(batch.ids).toHaveLength(mixed ? 2 : 1)
        expect(h.registry().sizes).toEqual({ prompts: 1, journalBindings: mixed ? 2 : 1 })
        expect(h.codex.connections[0].replies).toEqual([])
        const saved = h.journal.snapshot().items.filter((item) => item.body.kind === 'question')
        expect(
          saved.map((item) => [item.revision, item.body.kind === 'question' && item.body.question])
        ).toEqual(
          mixed
            ? [
                [2, 'Later?'],
                [1, 'Other?']
              ]
            : [[2, 'Later?']]
        )
        const before = h.journal.snapshot()
        const bytes = h.registry().bytes
        await h.deliver(0, 'questions', questions.length, 'turn-1', 'yes', questions)
        expect(h.journal.snapshot()).toEqual(before)
        expect(h.registry().bytes).toBe(bytes)
        expect(commits).toHaveBeenCalledOnce()
        unobserve()
        await h.answer(batch.ids[0]!)
        if (mixed) {
          expect(h.codex.connections[0].replies).toEqual([])
          expect(h.registry().sizes).toEqual({ prompts: 1, journalBindings: 1 })
          expect(h.registry().find(batch.ids[0]!)).toBeNull()
          expect(h.registry().find(batch.ids[1]!)).not.toBeNull()
          expect(h.registry().bytes).toBeGreaterThan(0)
          await h.answer(batch.ids[1]!)
        }
        expect(h.codex.connections[0].replies).toEqual([
          {
            id: 0,
            result: {
              answers: {
                pick: { answers: ['C'] },
                ...(mixed ? { other: { answers: ['E'] } } : {})
              }
            }
          }
        ])
        expect(h.registry().sizes).toEqual({ prompts: 0, journalBindings: 0 })
        expect(h.registry().bytes).toBe(0)
        expect(h.deferred.state()).toMatchObject({
          queuedOperations: 0,
          queuedBytes: 0,
          failed: false
        })
      } finally {
        await h.dispose()
      }
    }
  )

  it('refuses the exact newcomer at retained-byte pressure, keeps all admitted bindings, and releases them through real answers', async () => {
    const h = await journalHarness()
    try {
      const form = await h.deliver(0, 'form')
      const admitted: { requestId: number; itemId: string }[] = []
      let refused = 0
      for (let id = 1; id < 100; id++) {
        const batch = await h.deliver(id, 'questions', 1, 'turn-1', 'x'.repeat(65_500))
        if (batch.ids.length === 0) {
          refused = id
          break
        }
        admitted.push({ requestId: id, itemId: batch.ids[0]! })
      }
      expect(refused).toBeGreaterThan(1)
      expect(refused).toBeLessThan(100)
      expect(h.registry().sizes.journalBindings).toBe(admitted.length + 1)
      expect(h.registry().bytes).toBeLessThanOrEqual(bounds.MAX_CODEX_PROMPT_REGISTRY_BYTES)
      expect(h.registry().find(form.ids[0]!)).not.toBeNull()
      expect(h.codex.connections[0].replies).toEqual([
        { id: refused, code: -32001, message: expect.any(String) }
      ])
      await h.answer(form.ids[0]!)
      for (const request of admitted) {
        await h.answer(request.itemId, 'short exact answer')
      }
      for (const request of admitted) {
        expect(
          h.codex.connections[0].replies.filter((reply) => reply.id === request.requestId)
        ).toEqual([
          {
            id: request.requestId,
            result: { answers: { q0: { answers: ['short exact answer'] } } }
          }
        ])
      }
      await h.answer((await h.deliver(101, 'form')).ids[0]!)
      expect(h.registry().sizes).toEqual({ prompts: 0, journalBindings: 0 })
      expect(h.registry().bytes).toBe(0)
    } finally {
      await h.dispose()
    }
  })

  it('paces bytes and rejects whole incoming requests at actual sink count pressure, then completes every retained provider obligation after drain', async () => {
    const h = await journalHarness(true)
    try {
      const first = await h.deliver(0, 'form')
      const before = h.journal.snapshot().items
      h.pause()
      const batch = await h.deliver(1, 'questions', 64)
      expect(batch.ids).toHaveLength(64)
      expect(h.deferred?.state()).toMatchObject({ backpressured: true, queuedOperations: 1 })
      expect(h.deferred!.state().queuedBytes).toBeGreaterThan(16_000)
      expect(h.journal.snapshot().items).toEqual(before)
      expect(h.registry().sizes).toEqual({ prompts: 2, journalBindings: 65 })
      for (let i = 0; i < 7; i++) {
        expect(
          h.deferred?.sink.tryPublish?.({ lifecycle: true, coalescingKey: `held-${i}` })
        ).toEqual({ accepted: true })
      }
      expect(h.deferred?.state().queuedOperations).toBe(8)
      expect((await h.deliver(2, 'form')).ids).toEqual([])
      expect(h.journal.snapshot().items).toEqual(before)
      expect(h.codex.connections[0].replies).toEqual([
        { id: 2, code: -32001, message: expect.any(String) }
      ])
      await h.resume()
      await h.answer(first.ids[0]!)
      for (const id of batch.ids) {
        await h.answer(id)
      }
      await h.answer((await h.deliver(3, 'form')).ids[0]!)
      expect(
        h.codex.connections[0].replies.filter((reply) => reply.id === 0 || reply.id === 3)
      ).toEqual(
        [0, 3].map((id) => ({ id, result: { action: 'accept', content: {}, _meta: null } }))
      )
      expect(h.codex.connections[0].replies.filter((reply) => reply.id === 1)).toEqual([
        {
          id: 1,
          result: {
            answers: Object.fromEntries(
              Array.from({ length: 64 }, (_, i) => [`q${i}`, { answers: ['yes'] }])
            )
          }
        }
      ])
      expect(h.registry().sizes).toEqual({ prompts: 0, journalBindings: 0 })
      expect(h.deferred?.state()).toMatchObject({
        queuedOperations: 0,
        queuedBytes: 0,
        failed: false
      })
    } finally {
      await h.dispose()
    }
  })

  it('releases only completed ordinary bindings; refuses excess without evicting; completes every admitted provider request', async () => {
    const h = await journalHarness()
    try {
      const form = await h.deliver(0, 'form')
      const last: string[] = []
      for (let request = 1; request <= 4; request++) {
        const batch = await h.deliver(request, 'questions', 64)
        expect(batch.ids).toHaveLength(64)
        for (const id of batch.ids.slice(0, 63)) {
          await h.answer(id)
        }
        last.push(batch.ids[63]!)
        expect(h.registry().sizes.journalBindings).toBe(request + 1)
        expect(h.registry().find(form.ids[0]!)).not.toBeNull()
      }
      await h.answer(form.ids[0]!)
      expect(h.codex.connections[0].replies).toEqual([
        { id: 0, result: { action: 'accept', content: {}, _meta: null } }
      ])
      const ordinary: string[] = []
      for (let index = 0; index < 124; index++) {
        ordinary.push((await h.deliver(index + 10, 'approval')).ids[0]!)
      }
      const before = h.journal.snapshot().items
      for (const [id, kind] of [
        [201, 'questions'],
        [202, 'approval'],
        [203, 'form']
      ] as const) {
        expect((await h.deliver(id, kind, 2)).ids).toHaveLength(0)
        expect(h.codex.connections[0].replies.filter((reply) => reply.id === id)).toEqual([
          { id, code: -32001, message: expect.any(String) }
        ])
      }
      expect(h.journal.snapshot().items).toEqual(before)
      for (const id of [...last, ...ordinary]) {
        await h.answer(id)
      }
      expect(h.registry().sizes).toEqual({ prompts: 0, journalBindings: 0 })
      expect(new Set(h.codex.connections[0].replies.map((reply) => reply.id)).size).toBe(132)
      for (const reply of h.codex.connections[0].replies) {
        expect(
          h.codex.connections[0].replies.filter((other) => other.id === reply.id)
        ).toHaveLength(1)
      }
      for (let id = 300; id < 303; id++) {
        await h.answer((await h.deliver(id, 'form', 64)).ids[0]!)
      }
      const old = await h.deliver(400, 'approval')
      h.codex.connections[0].handlers.onNotification?.('turn/completed', {
        threadId: HOST_TEST_THREAD,
        turn: { id: 'turn-1', status: 'completed' }
      })
      expect(h.registry().find(old.ids[0]!)).toBeNull()
      await h.answer((await h.deliver(401, 'approval', 1, 'turn-2')).ids[0]!)
    } finally {
      await h.dispose()
    }
  })

  it('charges an awaited commit, reuses exact replay, and refuses a different owner at the same address', async () => {
    const h = await harness()
    try {
      const first = h.deliver(1, 'approval')
      h.codex.connections[0].handlers.onServerRequest?.(first.request)
      expect(h.registry().sizes).toEqual({ prompts: 1, journalBindings: 1 })
      let finish = () => {}
      const held = new Promise<void>((resolve) => {
        finish = resolve
      })
      const answering = h.answer(first.ids[0]!, undefined, () => held)
      const replacement = { ...first.request, id: 2 }
      h.codex.connections[0].handlers.onServerRequest?.(replacement)
      expect(h.codex.connections[0].replies).toEqual([
        { id: 2, code: -32001, message: expect.any(String) }
      ])
      expect(h.registry().find(first.ids[0]!)).not.toBeNull()
      expect(h.registry().sizes.journalBindings).toBe(1)
      finish()
      await answering
      expect(h.codex.connections[0].replies.at(-1)).toEqual({
        id: 1,
        result: { decision: 'accept' }
      })
    } finally {
      h.dispose()
    }
  })

  it('bounds real delivery, answer reservation and completion work at N and 10N retained requests', async () => {
    const counts: number[] = []
    for (const n of [10, 100]) {
      const h = await harness()
      const measuring = vi.spyOn(bounds, 'codexPromptRegistryEntryBytes')
      try {
        for (let i = 0; i < n - 1; i++) {
          h.deliver(i, 'approval')
        }
        const batch = h.deliver(500, 'questions', 2)
        measuring.mockClear()
        const started = performance.now()
        const incoming = h.deliver(501, 'approval')
        const admissionCalls = measuring.mock.calls.length
        measuring.mockClear()
        await h.answer(batch.ids[0]!)
        const answerCalls = measuring.mock.calls.length
        counts.push(admissionCalls + answerCalls)
        expect(admissionCalls).toBe(n + 1)
        expect(answerCalls).toBe(n + 1)
        expect(h.registry().sizes.journalBindings).toBe(n + 1)
        expect(h.registry().find(batch.ids[1]!)).not.toBeNull()
        expect(h.registry().find(incoming.ids[0]!)).not.toBeNull()
        console.info(
          `prompt production perf population=${n} admission=${admissionCalls} answer=${answerCalls} elapsedMs=${performance.now() - started}`
        )
      } finally {
        measuring.mockRestore()
        h.dispose()
      }
    }
    expect(counts[1]).toBeLessThanOrEqual(counts[0]! * 10)
  })
})
