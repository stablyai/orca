import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAutomationCatalog } from './use-automation-catalog'
import { useAutomationRuns, type AutomationRunScope } from './use-automation-runs'
import {
  automationClient,
  automationTargets,
  deferred,
  savedAutomation,
  savedRun
} from './automation-test-fixtures'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { useAutomationCreateAttempt } from './use-automation-create-attempt'
import { newAutomationDraft, validateAutomationDraft } from './automation-draft'
import { AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { AUTOMATION_OUTCOME_UNKNOWN } from './automation-error'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) }
}))
let tree: ReactTestRenderer | null = null
afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  vi.useRealTimers()
})
function latest<T>(read: () => T | null) {
  const value = read()
  if (!value) {
    throw new Error('Not mounted')
  }
  return value
}

describe('host-owned automation reads', () => {
  it.each([2, 20])('suspends a loaded %s-page history between visible consumers', async (pages) => {
    let runs = Array.from({ length: 30 * pages }, (_, index) => ({
      ...savedRun(`run-${index}`),
      createdAt: 10000 - index
    }))
    let reply: ReturnType<typeof deferred<unknown>> | undefined
    let requests = 0
    const port = automationClient((_method, params) => {
      requests++
      if (reply) {
        return reply.promise
      }
      const cursor =
        params && typeof params === 'object' && 'cursor' in params ? params.cursor : null
      const start = cursor ? runs.findIndex((run) => run.id === cursor) + 1 : 0
      const page = runs.slice(start, start + 30)
      return { runs: page, nextCursor: start + 30 < runs.length ? page.at(-1)?.id : null }
    })
    let state: ReturnType<typeof useAutomationRuns> | null = null
    let observing = false
    let revision = 0
    function Probe() {
      state = useAutomationRuns(port.client, null, revision, true, undefined, observing)
      return null
    }
    const read = () => latest(() => state)
    const update = async () => {
      await act(async () => {
        tree?.update(createElement(Probe))
      })
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    revision++
    await update()
    expect(requests).toBe(0)
    observing = true
    await update()
    for (let index = 1; index < pages; index++) {
      await act(async () => read().loadMore())
    }
    expect(requests).toBe(pages)
    const loaded = read().runs.map((run) => run.id)
    reply = deferred<unknown>()
    revision++
    await update()
    revision++
    await update()
    observing = false
    await update()
    runs = runs.map((run) => ({ ...run, workspaceDisplayName: 'Fresh after return' }))
    const issued = reply
    reply = undefined
    await act(async () => issued.resolve({ runs: runs.slice(0, 30), nextCursor: runs[29]!.id }))
    expect(requests).toBe(pages + 1)
    expect(read().runs.map((run) => run.id)).toEqual(loaded)
    for (let index = 0; index < 10; index++) {
      revision++
      await update()
    }
    expect(requests).toBe(pages + 1)
    observing = true
    await update()
    expect(requests).toBe(2 * pages + 1)
    expect(read().runs).toHaveLength(30 * pages)
    expect(read().runs.at(-1)?.workspaceDisplayName).toBe('Fresh after return')
    expect(
      port.send.mock.calls.every(([, params]) => !JSON.stringify(params).includes('expectedOwner'))
    ).toBe(true)
  })

  it.each([5, 50])(
    'releases only unreachable run payloads over %s host-pruned arrivals',
    async (arrivals) => {
      const global = Array.from({ length: 30 }, (_, index) => ({
        ...savedRun(`global-${index}`),
        createdAt: 1000 - index
      }))
      let detail = Array.from({ length: 100 }, (_, index) => ({
        ...savedRun(`detail-${index}`),
        createdAt: 2000 - index
      }))
      let failLaterPage = false
      const port = automationClient((_method, params) => {
        const request = params && typeof params === 'object' ? params : {}
        const runs = 'automationId' in request ? detail : global
        const cursor = 'cursor' in request ? request.cursor : null
        if (cursor && failLaterPage) {
          throw new Error('history interrupted')
        }
        const start = cursor ? runs.findIndex((run) => run.id === cursor) + 1 : 0
        const page = runs.slice(start, start + 30)
        return { runs: page, nextCursor: start + 30 < runs.length ? page.at(-1)?.id : null }
      })
      let state: ReturnType<typeof useAutomationRuns> | null = null
      let query: AutomationRunScope = null
      let selected: ReturnType<typeof savedRun> | undefined
      let revision = 0
      function Probe() {
        state = useAutomationRuns(port.client, query, revision, true, selected)
        return null
      }
      const read = () => latest(() => state)
      const update = async () => {
        revision++
        await act(async () => tree?.update(createElement(Probe)))
      }
      const recordMaps: Map<unknown, unknown>[] = []
      const set = Map.prototype.set
      Map.prototype.set = function (key, value) {
        if (
          value &&
          typeof value === 'object' &&
          'automationId' in value &&
          value.id === key &&
          !recordMaps.includes(this)
        ) {
          recordMaps.push(this)
        }
        return set.call(this, key, value)
      }
      try {
        await act(async () => {
          tree = create(createElement(Probe))
        })
      } finally {
        Map.prototype.set = set
      }
      expect(recordMaps).toHaveLength(1)
      const records = recordMaps[0]!
      selected = detail.at(-1)
      query = { automationId: 'automation-1', expectedOwner: { selector: { kind: 'self' } } }
      await update()
      expect(read().runs).toHaveLength(100)
      expect(records.size).toBe(130)
      for (let index = 0; index < arrivals; index++) {
        detail = [{ ...savedRun(`arrival-${index}`), createdAt: 3000 + index }, ...detail].slice(
          0,
          100
        )
        await update()
        expect(read().runs).toHaveLength(100)
        expect(records.size).toBe(131)
        expect(read().selected?.outputSnapshot).toEqual(selected?.outputSnapshot)
      }
      const lastGood = read().runs.map((run) => run.id)
      detail = Array.from({ length: 100 }, (_, index) => ({
        ...savedRun(`replacement-${index}`),
        createdAt: 5000 - index
      }))
      failLaterPage = true
      await update()
      expect(read().error).toBeTruthy()
      expect(read().runs.map((run) => run.id)).toEqual(lastGood)
      expect(records.size).toBe(161)
      expect(read().selected?.outputSnapshot).toEqual(selected?.outputSnapshot)
      failLaterPage = false
      await update()
      expect(read().error).toBeNull()
      expect(records.size).toBe(131)
      query = null
      await update()
      expect(read().runs.map((run) => run.id)).toEqual(global.map((run) => run.id))
      expect(records.size).toBe(131)
      selected = undefined
      await update()
      expect(records.size).toBe(130)
      expect(records.has('detail-99')).toBe(false)
    }
  )

  it.each(['success', 'unreadable', 'post-write-error'] as const)(
    'keeps list affirmation after the original create returns %s',
    async (outcome) => {
      const reply = deferred<unknown>()
      let listed: ReturnType<typeof savedAutomation>[] = []
      const port = automationClient((method) => {
        if (method === 'status.get') {
          return { capabilities: [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] }
        }
        if (method === 'automation.create') {
          return reply.promise
        }
        return {
          automations: listed,
          items: listed.map((a) => ({ automationId: a.id, selector: { kind: 'self' } }))
        }
      })
      const reconciled = vi.fn()
      let state: {
        catalog: ReturnType<typeof useAutomationCatalog>
        attempt: ReturnType<typeof useAutomationCreateAttempt>
      } | null = null
      function Probe() {
        const catalog = useAutomationCatalog(port.client, false)
        const attempt = useAutomationCreateAttempt(
          catalog.rows,
          true,
          reconciled,
          catalog.isCurrentSnapshot
        )
        state = { catalog, attempt }
        return null
      }
      await act(async () => {
        tree = create(createElement(Probe))
      })
      const read = () => latest(() => state)
      const targets = automationTargets()
      const setup = targets.setups[0]!
      const draft = {
        ...newAutomationDraft(),
        name: 'Review',
        prompt: 'Submitted A',
        agentId: 'codex' as const,
        setupId: JSON.stringify([setup.hostId, setup.id, setup.repoId, setup.path])
      }
      let pending: Promise<void> | undefined
      await act(async () => {
        read().attempt.observeDraft(draft)
        pending = read().catalog.perform(
          (client, current) =>
            read().attempt.submit(
              client,
              draft,
              targets,
              [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY],
              current
            ),
          () => {}
        )
      })
      const params = port.send.mock.calls.find(([method]) => method === 'automation.create')?.[1]
      if (!params || typeof params !== 'object' || !('creationKey' in params)) {
        throw new Error('missing command')
      }
      listed = [
        {
          ...savedAutomation(),
          creationKey: String(params.creationKey),
          name: 'Host name',
          prompt: 'Submitted A',
          enabled: false
        }
      ]
      await act(async () => {
        read().attempt.observeDraft({ ...draft, prompt: 'Edited B' })
        port.event({ type: 'automationsChanged' })
      })
      expect(reconciled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ automation: expect.objectContaining({ enabled: false }) }),
        expect.objectContaining({ name: 'Host name', prompt: 'Edited B' })
      )
      await act(async () => {
        if (outcome === 'post-write-error') {
          reply.reject(markRpcDeliveryUnknown(new Error('post-write connection loss')))
        } else {
          reply.resolve(outcome === 'success' ? { automation: listed[0] } : {})
        }
        await pending
      })
      expect(read().catalog.error).toBeNull()
      expect(read().catalog.busy).toBe(false)
      expect(reconciled).toHaveBeenCalledTimes(1)
      expect(
        port.send.mock.calls.filter(([method]) => method === 'automation.create')
      ).toHaveLength(1)
      expect(
        port.send.mock.calls.filter(([method]) => method === 'automation.update')
      ).toHaveLength(0)
    }
  )

  it.each([false, true])(
    'allows correction only before possible application (keyed=%s)',
    async (keyed) => {
      const port = automationClient(() => ({ automation: savedAutomation() }))
      let state: ReturnType<typeof useAutomationCreateAttempt> | null = null
      function Probe() {
        state = useAutomationCreateAttempt([], true, vi.fn(), () => true)
        return null
      }
      await act(async () => {
        tree = create(createElement(Probe))
      })
      const targets = automationTargets()
      const setup = targets.setups[0]!
      const draft = {
        ...newAutomationDraft(),
        name: 'Review',
        prompt: 'Submitted A',
        agentId: 'codex' as const,
        setupId: JSON.stringify([setup.hostId, setup.id, setup.repoId, setup.path]),
        extraAgentArgs: '--not-a-real-option'
      }
      const submit = (next = draft) =>
        latest(() => state).submit(
          port.client,
          next,
          targets,
          keyed ? [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY] : [],
          () => true
        )
      expect(validateAutomationDraft(draft, 1)).toBeTruthy()
      await expect(submit()).rejects.toThrow()
      expect(port.send).not.toHaveBeenCalled()
      draft.extraAgentArgs = '--model gpt-5'
      expect(validateAutomationDraft(draft, 1)).toBeNull()
      port.send.mockRejectedValueOnce(new Error('disconnected before write'))
      await expect(submit()).rejects.toThrow('disconnected before write')
      port.send.mockResolvedValueOnce({
        id: 'reply',
        ok: false,
        error: { code: 'forbidden', message: 'Admission refused' }
      })
      await expect(submit({ ...draft, prompt: 'Corrected before send' })).rejects.toThrow()
      await submit({ ...draft, prompt: 'Accepted C' })
      expect(port.send).toHaveBeenCalledTimes(3)
      expect(port.send.mock.calls.at(-1)?.[1]).toMatchObject({
        prompt: 'Accepted C',
        extraAgentArgs: '--model gpt-5',
        ...(keyed ? { creationKey: expect.any(String) } : {})
      })
    }
  )

  it.each(['timeout', 'runtime_error', 'unreadable'] as const)(
    'retains the original command after %s, even when its retry never sends',
    async (failure) => {
      const port = automationClient(() => ({}))
      let state: ReturnType<typeof useAutomationCreateAttempt> | null = null
      function Probe() {
        state = useAutomationCreateAttempt([], true, vi.fn(), () => true)
        return null
      }
      await act(async () => {
        tree = create(createElement(Probe))
      })
      const setup = automationTargets().setups[0]!
      const draft = {
        ...newAutomationDraft(),
        name: 'Review',
        prompt: 'Submitted A',
        agentId: 'codex' as const,
        setupId: JSON.stringify([setup.hostId, setup.id, setup.repoId, setup.path])
      }
      const submit = (prompt: string) =>
        latest(() => state).submit(
          port.client,
          { ...draft, prompt },
          automationTargets(),
          [AUTOMATION_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY],
          () => true
        )
      if (failure === 'timeout') {
        port.send.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('sent timeout')))
      } else if (failure === 'runtime_error') {
        port.send.mockResolvedValueOnce({
          id: 'reply',
          ok: false,
          error: { code: 'runtime_error', message: 'flush failed after write' }
        })
      }
      await expect(submit('Submitted A')).rejects.toThrow(AUTOMATION_OUTCOME_UNKNOWN)
      port.send.mockRejectedValueOnce(new Error('retry never sent'))
      await expect(submit('Edited B')).rejects.toThrow(AUTOMATION_OUTCOME_UNKNOWN)
      port.send.mockResolvedValueOnce({
        id: 'reply',
        ok: false,
        error: { code: 'forbidden', message: 'retry refused' }
      })
      await expect(submit('Edited C')).rejects.toThrow(AUTOMATION_OUTCOME_UNKNOWN)
      expect(port.send.mock.calls[1]?.[1]).toEqual(port.send.mock.calls[0]?.[1])
      expect(port.send.mock.calls[2]?.[1]).toEqual(port.send.mock.calls[0]?.[1])
      expect(port.send.mock.calls[0]?.[1]).toMatchObject({
        prompt: 'Submitted A',
        creationKey: expect.any(String),
        dtstart: expect.any(Number)
      })
    }
  )

  it('observes old loaded/selected identities through failures, reconnect and captured scopes', async () => {
    let runs = Array.from({ length: 65 }, (_, i) => ({
      ...savedRun(`r-${i}`),
      createdAt: 1000 - i,
      status: i === 64 ? 'dispatched' : 'completed'
    }))
    let fail = false
    const queries: unknown[] = []
    const port = automationClient((_method, params) => {
      queries.push(params)
      const request = params && typeof params === 'object' ? params : {}
      if (fail) {
        throw new Error('connection failed')
      }
      const cursor = 'cursor' in request ? request.cursor : undefined
      const start = cursor ? runs.findIndex((run) => run.id === cursor) + 1 : 0
      const page = runs.slice(start, start + 30)
      return { runs: page, nextCursor: start + 30 < runs.length ? page.at(-1)?.id : null }
    })
    let state: ReturnType<typeof useAutomationRuns> | null = null
    let query: AutomationRunScope = null
    let selected: ReturnType<typeof savedRun> | undefined
    function Probe({ revision, connected }: { revision: number; connected: boolean }) {
      state = useAutomationRuns(port.client, query, revision, connected, selected)
      return null
    }
    const read = () => latest(() => state)
    const update = async (revision: number, connected = true) => {
      await act(async () => {
        tree?.update(createElement(Probe, { revision, connected }))
      })
    }
    await act(async () => {
      tree = create(createElement(Probe, { revision: 0, connected: true }))
    })
    await act(async () => {
      read().loadMore()
    })
    await act(async () => {
      read().loadMore()
    })
    selected = read().runs.at(-1)
    expect(selected?.id).toBe('r-64')
    runs = [
      ...Array.from({ length: 40 }, (_, i) => ({
        ...savedRun(`new-${i}`),
        createdAt: 2000 - i,
        status: 'completed'
      })),
      ...runs.map((run) =>
        run.id === 'r-64'
          ? {
              ...run,
              status: 'completed',
              outputSnapshot: { content: 'Final saved output', capturedAt: 3000, truncated: false }
            }
          : run
      )
    ]
    fail = true
    await update(1)
    expect(read().selected?.status).toBe('dispatched')
    expect(read().error).toBeTruthy()
    await act(async () => {
      port.state('disconnected')
    })
    await update(1, false)
    fail = false
    await act(async () => {
      port.state('connected')
    })
    await update(2)
    expect(read().selected?.outputSnapshot?.content).toBe('Final saved output')
    expect(read().runs.find((run) => run.id === 'r-64')?.status).toBe('completed')
    expect(queries.every((params) => !JSON.stringify(params).includes('expectedOwner'))).toBe(true)
    runs = runs.map((run) =>
      run.id === 'r-64' ? { ...run, workspaceDisplayName: 'Renamed after completion' } : run
    )
    await update(3)
    expect(read().selected?.workspaceDisplayName).toBe('Renamed after completion')
    query = {
      automationId: 'automation-1',
      expectedOwner: { selector: { kind: 'ssh', targetId: 'captured', targetGeneration: 7 } }
    }
    queries.length = 0
    await update(4)
    expect(queries.length).toBeGreaterThan(3)
    expect(queries.every((params) => JSON.stringify(params).includes('captured'))).toBe(true)
    selected = undefined
    await update(5)
    expect(read().runs.at(-1)?.id).toBe('r-64')
  })
  it('ignores a previous connection snapshot and keeps delivery ambiguity until explicit refresh', async () => {
    const pending = deferred<unknown>()
    let listReads = 0
    const automation = savedAutomation()
    const catalogReply = {
      automations: [automation],
      items: [{ automationId: automation.id, selector: { kind: 'self' } }]
    }
    const port = automationClient((method) => {
      if (method === 'status.get') {
        return { capabilities: [] }
      }
      return ++listReads === 1 ? pending.promise : catalogReply
    })
    let state: ReturnType<typeof useAutomationCatalog> | null = null
    function Probe() {
      state = useAutomationCatalog(port.client, false)
      return null
    }
    const read = () => latest(() => state)
    await act(async () => {
      tree = create(createElement(Probe))
    })
    await act(async () => {
      port.state('disconnected')
      port.state('connected')
    })
    await act(async () => {
      pending.resolve({ automations: [], items: [] })
    })
    expect(read().rows.map((row) => row.automation.id)).toEqual(['automation-1'])
    let attempts = 0
    await act(async () => {
      await read().perform(
        async () => {
          attempts++
          throw markRpcDeliveryUnknown(new Error('Connection lost'))
        },
        () => {}
      )
    })
    expect(attempts).toBe(1)
    expect(read().error).toContain('may have applied')
    await act(async () => {
      port.event({ type: 'automationsChanged' })
    })
    expect(read().error).toContain('may have applied')
    await act(async () => {
      await read().refresh(true)
    })
    expect(read().error).toBeNull()
  })
  it('reports a superseded action as unknown and settles without accepting its reply', async () => {
    const port = automationClient((method) =>
      method === 'status.get' ? { capabilities: [] } : { automations: [], items: [] }
    )
    let state: ReturnType<typeof useAutomationCatalog> | null = null
    function Probe() {
      state = useAutomationCatalog(port.client, false)
      return null
    }
    await act(async () => {
      tree = create(createElement(Probe))
    })
    const read = () => latest(() => state)
    const accept = vi.fn()
    await act(async () => {
      await read().perform(async () => {
        port.state('connected')
        return savedRun('accepted-on-host')
      }, accept)
    })
    expect(accept).not.toHaveBeenCalled()
    expect(read().busy).toBe(false)
    expect(read().error).toContain('may have applied')
    expect(
      port.send.mock.calls.filter(([method]) => method === 'automation.list').length
    ).toBeGreaterThan(1)
  })
})
