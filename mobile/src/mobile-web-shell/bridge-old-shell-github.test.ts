import { expect, it } from 'vitest'
import { captureBridgeError } from './bridge/bridge-error-capture'
import { BridgeHostRequests as LegacyHostRequests } from './bridge-host-requests.legacy.test-fixture'
import { readBridgeClientMessage } from './bridge/bridge-envelope'
import { createPageClient, INIT, GRANTS } from './bridge/bridge-page-client-test-harness'
import { createFakeRpcClient, rpcSuccess } from './bridge-host-test-fakes'
import { withGitHubTargetOperation } from '../tasks/github-work-item-operation'

// The forwarder is the pinned pre-fence implementation; its envelope parser is unchanged since that build.
function pair(options: { capable?: boolean; switchAfterCheck?: boolean } = {}) {
  const physical = createFakeRpcClient()
  const calls: { method: string; args: readonly unknown[] }[] = []
  const effects: string[] = []
  let endpoint = 'A'
  physical.sendRequest = async (...args) => {
    const [method, params] = args
    calls.push({ method, args })
    if (method === 'status.get') {
      const response = rpcSuccess('status', {
        runtimeId: 'A',
        hostDescriptor: { installationId: 'A' },
        capabilities: options.capable === false ? [] : ['github.exact-work-item-target.v1']
      })
      if (options.switchAfterCheck) {
        endpoint = 'pre-fence-B'
      }
      return response
    }
    if (method === 'github.updateIssue') {
      const exact =
        params && typeof params === 'object' && 'ownerRepo' in params ? params.ownerRepo : null
      effects.push(endpoint === 'A' && exact ? 'fork' : 'upstream')
      return rpcSuccess('mutation', { ok: true })
    }
    return rpcSuccess('optional', null)
  }
  let host!: LegacyHostRequests
  const page = createPageClient({
    send: (json) => {
      const read = readBridgeClientMessage(json)
      if (!read.ok) {
        throw new Error(`old parser refused: ${read.refusal}`)
      }
      if (read.message.type === 'request') {
        host.open(read.message)
      }
    }
  })
  host = new LegacyHostRequests({
    client: physical,
    isIdTaken: () => false,
    sendReply: (id, payload) => page.deliver({ v: 1, type: 'reply', id, payload }),
    sendError: (id, error) =>
      page.deliver({ v: 1, type: 'error', id, error: captureBridgeError(error) }),
    capExceeded: (message) => new Error(message),
    serveNative: async () => rpcSuccess('native', null),
    readClientIdentity: () => 'phone'
  })
  page.deliver({ ...INIT, grants: { ...GRANTS, native: ['rpcEnvelope'] } })
  return {
    page,
    host,
    calls,
    effects,
    close: () => {
      page.client.close()
      host.closeAll(false)
    }
  }
}
async function closeIssue(fixture: ReturnType<typeof pair>) {
  return withGitHubTargetOperation({
    client: fixture.page.client,
    params: { repo: 'id:clone' },
    ownerRepo: { owner: 'fork', repo: 'widgets' },
    send: async (client, exact, options) =>
      client.sendRequest(
        'github.updateIssue',
        { repo: 'id:clone', number: 93, updates: { state: 'closed' }, ...exact },
        options
      )
  })
}
it('a checked capable endpoint still closes through the actual old parser/forwarder without a phone grant or accessor', async () => {
  const f = pair()
  try {
    expect(await closeIssue(f)).toMatchObject({ ok: true, result: { ok: true } })
    expect(f.calls.map((call) => call.method)).toEqual(['status.get', 'github.updateIssue'])
    expect(f.calls[1].args[1]).toMatchObject({
      repo: 'id:clone',
      ownerRepo: { owner: 'fork', repo: 'widgets' },
      updates: { state: 'closed' }
    })
    expect(f.calls[1].args[2]).toMatchObject({
      envelope: { expectedRuntimeSource: { sourceId: 'A', runtimeId: 'A' } }
    })
    expect(f.calls[1].args[2]).not.toHaveProperty('beforeSend')
    expect(f.effects).toEqual(['fork'])
    await f.page.client.sendRequest('optional.no-params')
    await f.page.client.sendRequest('optional.params', { value: 1 })
    expect(f.calls.slice(2).map((call) => call.args)).toEqual([
      ['optional.no-params'],
      ['optional.params', { value: 1 }]
    ])
  } finally {
    f.close()
  }
})
it('an old server is refused before unsafe generic send even through the old shell', async () => {
  const f = pair({ capable: false })
  try {
    await expect(closeIssue(f)).rejects.toThrow('Update Orca')
    expect(f.calls.map((call) => call.method)).toEqual(['status.get'])
    expect(f.effects).toEqual([])
  } finally {
    f.close()
  }
})
it('documents the accepted authenticated check/send switch residual on a pre-fence installed shell', async () => {
  const f = pair({ switchAfterCheck: true })
  try {
    expect(await closeIssue(f)).toMatchObject({ ok: true })
    expect(f.effects).toEqual(['upstream'])
    expect(f.calls).toHaveLength(2)
  } finally {
    f.close()
  }
})
