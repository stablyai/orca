import { expect } from 'vitest'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionResult
} from '../../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../../../shared/agent-session/options/agent-session-options-result'
import type { AgentModelCatalogService } from '../../../agent-model-catalog/agent-model-catalog-service-contract'
import type { StructuredAgentSessionMutationContext } from '../../operations/structured-agent-session-mutation-context'
import type { StructuredAgentSessionLiveOptions } from '../../options/structured-agent-session-option-models'
import {
  hostTestCatalogReadOperation,
  hostTestRestingOptionsRecord,
  hostTestRestingOptionsJournal,
  hostTestOptionsReadStore
} from './structured-agent-session-host-test-data.test-fixture'
import { readStructuredAgentSessionOptions } from '../../options/structured-agent-session-options-read'

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
        conversation: async () => conversation,
        sessions: new Map([[sessionId, conversation]])
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
