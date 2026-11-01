import { expect, it } from 'vitest'
import { piOptionActualContract } from './structured-agent-session-option-actual.test-fixture'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type {
  PiRefreshHarness,
  PiRefreshMount
} from '../../../shared/structured-agent-session-option-refresh.test-fixture-contract'
import type { AgentModelCatalogService } from '../agent-model-catalog/agent-model-catalog-service'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionLiveOptions } from './structured-agent-session-option-models'
import {
  hostTestCatalogReadOperation,
  hostTestRestingOptionsRecord,
  hostTestRestingOptionsJournal,
  hostTestOptionsReadStore
} from './structured-agent-session-host-test-data'
import { readStructuredAgentSessionOptions } from './structured-agent-session-options-read'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

const levels = (values: string[]) => values.map((value) => ({ value, label: value }))
const gap = levels(['off', 'minimal', 'low', 'xhigh'])
const precise = levels(['off', 'minimal', 'low', 'high', 'xhigh'])

/** Exercise the host's actual rest/live reader; only transport completion is held. */
export function piOptionRefreshHost(sessionId = 'session-1') {
  const record = {
    ...hostTestRestingOptionsRecord(sessionId),
    provider: 'pi',
    options: { model: 'openai/model', effort: 'medium' }
  }
  const row = { id: record.options.model, label: 'Model', isDefault: false, efforts: gap }
  let live: StructuredAgentSessionLiveOptions | null = null
  let modelCatalog: Pick<AgentModelCatalogService, 'read' | 'captureRead'> | null = null
  const requests: ReturnType<typeof deferred<AgentSessionOptionsResult>>[] = []
  const host = {
    record,
    models: [row],
    get live(): StructuredAgentSessionLiveOptions | null {
      return live
    },
    set live(value: StructuredAgentSessionLiveOptions | null) {
      live = value
    },
    get modelCatalog(): Pick<AgentModelCatalogService, 'read' | 'captureRead'> | null {
      return modelCatalog
    },
    set modelCatalog(value: Pick<AgentModelCatalogService, 'read' | 'captureRead'> | null) {
      modelCatalog = value
    },
    hostReads: 0,
    catalogReads: 0,
    passiveReads: 0,
    requests,
    initialCatalog: deferred<AgentSessionModelCatalogResult>(),
    catalogCalls: 0,
    blockWrite: false,
    write: deferred<void>(),
    acceptEffort: async (value: string): Promise<AgentSessionOptionResult> => {
      if (host.blockWrite) {
        await host.write.promise
      }
      record.options.effort = value
      return { key: 'effort', value, options: { ...record.options } }
    },
    home: {
      origin: 'probe',
      fetchedAt: 2,
      models: [{ ...row, efforts: precise }]
    } satisfies AgentSessionModelCatalogResult,
    catalog: (): Promise<AgentSessionModelCatalogResult> =>
      ++host.catalogCalls === 1 ? host.initialCatalog.promise : Promise.resolve(host.home),
    read: async (): Promise<AgentSessionOptionsResult> => {
      host.hostReads += 1
      const conversation = {
        child: host.live ? { fence: 2, phase: 'ready' } : null,
        params: { provider: 'pi' },
        journal: hostTestRestingOptionsJournal()
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real reader accesses only these injected ports; no provider process is launched.
      const context = {
        deps: {
          adapter: {
            readOptions: async () => {
              host.passiveReads += 1
              return host.live
            }
          },
          agents: { definition: () => null, capabilities: () => null },
          store: hostTestOptionsReadStore(() => record),
          modelCatalog: host.modelCatalog ?? {
            captureRead: hostTestCatalogReadOperation,
            read: async (params: { savedOnly?: boolean }) => {
              expect(params.savedOnly).toBe(true)
              host.catalogReads += 1
              return { origin: 'probe', fetchedAt: 1, models: host.models }
            }
          }
        },
        serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
        openConversation: async () => conversation,
        conversation: async () => conversation
      } as unknown as StructuredAgentSessionMutationContext
      return readStructuredAgentSessionOptions(context, sessionId, { readsWithoutModel: true })
    },
    options: (): Promise<AgentSessionOptionsResult> => {
      const answer = host.read()
      if (host.hostReads === 1) {
        return answer
      }
      const request = deferred<AgentSessionOptionsResult>()
      host.requests.push(request)
      // Sample at dispatch, rather than giving an old request the state at its eventual completion.
      return Promise.all([answer, request.promise]).then(([sampled]) => sampled)
    },
    finish: (index: number): void => host.requests[index]!.resolve({ models: [], current: {} })
  }
  return host
}

function effort(view: PiRefreshHarness) {
  return view.snapshot().find((entry) => entry.id === 'effort')
}
function assertView(view: PiRefreshHarness, selected: string, choices = gap) {
  expect(effort(view)).toMatchObject({
    settable: true,
    kind: { currentValue: selected, choices }
  })
  expect(effort(view)?.valueSource).not.toBe('reported')
}

export function piOptionRefreshContract(
  mount: PiRefreshMount,
  flush: (work: () => void) => Promise<void>
): void {
  piOptionActualContract(piOptionRefreshHost, mount, flush)
  it('completes a catalog burst through the host with one active and one trailing read per owner at 6 and 60 owners', async () => {
    const counts: number[] = []
    for (const population of [6, 60]) {
      const hosts = Array.from({ length: population }, (_, index) =>
        piOptionRefreshHost(`refresh-${index}`)
      )
      const views: PiRefreshHarness[] = []
      for (const host of hosts) {
        views.push(await mount(host))
      }
      for (const view of views) {
        assertView(view, 'xhigh')
        expect(view.capture()?.effort).toBe('medium')
      }
      await flush(() => hosts.forEach((host) => host.initialCatalog.resolve(host.home)))
      expect(hosts.map((host) => host.requests.length)).toEqual(Array(population).fill(1))
      for (let burst = 0; burst < 3; burst += 1) {
        await flush(() => views.forEach((view) => view.demand()))
      }
      for (const view of views) {
        assertView(view, 'xhigh')
      }
      expect(
        hosts.every((host) => host.hostReads === 2 && host.record.options.effort === 'medium')
      ).toBe(true)
      hosts.forEach((host) => {
        host.models = host.home.models
      })
      await flush(() => hosts.forEach((host) => host.finish(0)))
      expect(hosts.every((host) => host.requests.length === 2)).toBe(true)
      for (const view of views) {
        assertView(view, 'xhigh')
      }
      await flush(() => hosts.forEach((host) => host.finish(1)))
      for (const view of views) {
        assertView(view, 'high', precise)
      }
      counts.push(hosts.reduce((count, host) => count + host.hostReads, 0))
      expect(
        hosts.every(
          (host) => host.hostReads === 3 && host.catalogReads <= 6 && host.passiveReads === 0
        )
      ).toBe(true)
      expect(hosts.every((host) => host.record.options.effort === 'medium')).toBe(true)
      for (const view of views) {
        await view.close()
      }
    }
    expect(counts).toEqual([18, 180])
  })

  it('releases failed reads, retains last-good without an invented retry, and drops queued work on teardown', async () => {
    const host = piOptionRefreshHost()
    const view = await mount(host)
    await flush(() => host.initialCatalog.resolve(host.home))
    await flush(() => host.requests[0]!.reject(new Error('read failed')))
    assertView(view, 'xhigh')
    expect(host.hostReads).toBe(2)
    await flush(() => {})
    expect(host.hostReads).toBe(2)
    await flush(() => view.demand())
    await flush(() => view.demand())
    host.models = host.home.models
    await flush(() => host.requests[1]!.reject(new Error('read timeout')))
    expect(host.requests).toHaveLength(3)
    await flush(() => host.finish(2))
    assertView(view, 'high', precise)
    expect(host.record.options.effort).toBe('medium')
    await flush(() => view.demand())
    await flush(() => view.demand())
    const dispatched = host.hostReads
    await view.close()
    await flush(() => host.finish(3))
    expect(host.hostReads).toBe(dispatched)
  })

  it('preserves a newer accepted High across an old answer, write parking, and a live-home refresh', async () => {
    const host = piOptionRefreshHost()
    host.models = host.home.models
    const view = await mount(host)
    await flush(() => host.initialCatalog.resolve(host.home))
    host.blockWrite = true
    await flush(() => {
      void view.pick('high')
    })
    await flush(() => view.demand())
    await flush(() => host.finish(0))
    // Reads may complete while a controller write is pending; the raw overlay still wins.
    expect(host.requests).toHaveLength(2)
    expect(view.capture()?.effort).toBe('high')
    await flush(() => host.write.resolve())
    assertView(view, 'high', precise)
    expect(host.record.options.effort).toBe('high')
    await flush(() => host.finish(1))
    expect(host.requests).toHaveLength(3)
    // A held live answer carries future raw High, with no claim that the provider applied it.
    host.live = {
      models: [{ ...host.models[0]!, efforts: precise }],
      current: { model: host.record.options.model, effort: 'high' }
    }
    await flush(() => host.finish(2))
    assertView(view, 'high', precise)
    host.home = { ...host.home, models: [{ ...host.models[0]!, efforts: levels(['minimal']) }] }
    await flush(() => view.demand())
    await flush(() => host.finish(3))
    assertView(view, 'high', precise)
    expect(host.passiveReads).toBe(1)
    await view.close()
  })

  it('fences old and queued answers across child replacement and host/context replacement', async () => {
    const host = piOptionRefreshHost()
    const view = await mount(host)
    await flush(() => host.initialCatalog.resolve(host.home))
    await flush(() => view.demand())
    host.models = host.home.models
    host.live = {
      models: host.models,
      current: { model: host.record.options.model, effort: 'medium' }
    }
    await view.replace(2)
    const afterReplacement = host.hostReads
    await flush(() => host.finish(0))
    expect(host.hostReads).toBe(afterReplacement)
    await view.replace(3)
    const beforeOldChild = view.snapshot()
    await flush(() => host.finish(1))
    expect(view.snapshot()).toEqual(beforeOldChild)
    // Phase equality is not child identity; then live-to-rest also changes host/client.
    host.live = null
    await view.replace(4, true)
    const afterHostChange = host.hostReads
    const beforeOldHost = view.snapshot()
    await flush(() => host.finish(2))
    expect(host.hostReads).toBe(afterHostChange)
    expect(view.snapshot()).toEqual(beforeOldHost)
    await flush(() => host.finish(3))
    // A new host's catalog completion can supersede its first options read once.
    expect(host.requests.length).toBeLessThanOrEqual(5)
    if (host.requests.length === 5) {
      await flush(() => host.finish(4))
    }
    assertView(view, 'high', precise)
    expect(host.record.options.effort).toBe('medium')
    await view.close()
  })
}
