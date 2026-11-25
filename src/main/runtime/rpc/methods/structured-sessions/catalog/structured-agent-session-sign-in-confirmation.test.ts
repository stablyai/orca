import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { ModelCatalogParams } from '../../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'
import {
  harness,
  listing,
  record
} from '../../../../../native-chat/agent-model-catalog/agent-model-catalog-account-list-test-support'
import type { AgentModelCatalogProbe } from '../../../../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { StructuredAgentSessionHostDeps } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { createStructuredAgentSessionCatalogReads } from '../../../../../native-chat/agent-session-wire/options/structured-agent-session-catalog-reads'

type Probe = Awaited<ReturnType<NonNullable<AgentModelCatalogProbe['resolve']>>>['run']
const SESSION = 'session-alpha'
const complete = listing(['fixture-model'])
const signedIn = { ...complete, signedIn: true } as const

function fixture(run: Probe) {
  const probe: AgentModelCatalogProbe = Object.assign(() => Promise.resolve(complete), {
    resolve: async () => ({ identity: { command: 'fixture-codex' }, run })
  })
  const { service } = harness('codex', {
    probes: { codex: probe },
    recordWorkspacePath: async () => '/fixture-workspace'
  })
  const saved = agentSessionConversationView(record(SESSION))
  let accountHome = saved.accountHome
  const deps: Pick<StructuredAgentSessionHostDeps, 'modelCatalog'> = { modelCatalog: service }
  const readModelCatalog = createStructuredAgentSessionCatalogReads(() => ({
    deps,
    serialize: (_id, task) => task(),
    scopeOwned: async () => ({ record: saved, scoped: { ...saved, accountHome }, savedOnly: false })
  }))
  return {
    changeAccount: () => {
      accountHome = { variable: 'CODEX_HOME', path: '/fixture-other' }
    },
    read: (params: Record<string, unknown>, progress = true) =>
      readModelCatalog({
        ...ModelCatalogParams.parse({ agent: 'codex', sessionId: SESSION, ...params }),
        progress
      })
  }
}

afterEach(() => {
  vi.useRealTimers()
})

it.each([false, true])(
  'waits for the owning probe in the same tick, with an existing row: %s',
  async (seed) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1000)
    const partial = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let runs = 0
    const { read } = fixture(async (_signal, _operation, _targets, publish) => {
      if (++runs === 1 && seed) {
        return complete
      }
      publish?.({ ...complete, complete: false })
      partial.resolve()
      await finish.promise
      return signedIn
    })
    if (seed) {
      await read({ waitForListing: true })
    }
    const response = read({ confirmSignIn: true })
    try {
      await Promise.race([partial.promise, response])
      const checkpoint = await read({ savedOnly: true })
      expect(checkpoint).toMatchObject({ origin: 'probe' })
      expect(await Promise.race([response, Promise.resolve('pending')])).toBe('pending')
    } finally {
      finish.resolve()
    }
    expect(await response).toMatchObject({ signInConfirmed: true })
  }
)

it.each(['failed', 'inconclusive', 'changed-account'] as const)(
  'withholds confirmation after a partial row: %s',
  async (outcome) => {
    const { read, changeAccount } = fixture(async (_signal, _operation, _targets, publish) => {
      publish?.({ ...signedIn, complete: false }, true)
      if (outcome === 'failed') {
        throw new Error('fixture probe stopped')
      }
      if (outcome === 'changed-account') {
        changeAccount()
        return signedIn
      }
      return complete
    })
    const response = await read({ confirmSignIn: true }, false)
    expect(response).toMatchObject({ origin: 'probe' })
    expect(response).not.toHaveProperty('signInConfirmed')
  }
)

it('waits past an in-flight successful probe and uses the new probe’s inconclusive result', async () => {
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let runs = 0
  const { read } = fixture(async () => {
    if (++runs === 1) {
      started.resolve()
      await release.promise
      return signedIn
    }
    return complete
  })
  const earlier = read({ waitForListing: true })
  await started.promise
  const current = read({ confirmSignIn: true })
  await read({ savedOnly: true })
  release.resolve()
  expect(await earlier).not.toHaveProperty('signInConfirmed')
  const response = await current
  expect(response).toMatchObject({ origin: 'probe' })
  expect(response).not.toHaveProperty('signInConfirmed')
  expect(runs).toBe(2)
})
