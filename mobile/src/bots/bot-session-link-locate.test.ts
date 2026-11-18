import { describe, expect, it, vi } from 'vitest'
import { locateBotSessionLink } from './bot-session-link-locate'
import type { BotSessionLinkTarget } from './bot-link-target'
import type { BotLinkComputerAnswer } from './bot-link-host-reads'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { SendRequestOptions } from '../transport/rpc/unvalidated-rpc-request-port'

const target: BotSessionLinkTarget = {
  kind: 'session',
  botId: 'atlas',
  conversation: { source: 'slack', externalId: 'C1:123.4' },
  sessionId: 'lead-1',
  itemId: 'question-2'
}
const computer: BotLinkComputerAnswer = {
  key: 'paired-1\nlocal',
  pairedHostId: 'paired-1',
  executionHost: 'local',
  answer: {
    kind: 'bots',
    sessionItemLinks: true,
    bots: [{ id: 'atlas', name: 'Atlas', folderWorkspaceId: 'home-1' }]
  }
}

function host(
  options: {
    associated?: boolean
    workerHost?: 'local' | 'remote'
    reconnect?: boolean
    legacyReceiver?: boolean
    legacyServingHost?: boolean
    waitForLinks?: Promise<void>
    unreadableStatus?: boolean
    refusedLinks?: boolean
  } = {}
) {
  let generation = 1
  const request = vi.fn(
    async (
      method: string,
      _params?: unknown,
      requestOptions?: SendRequestOptions
    ): Promise<RpcResponse> => {
      let result: unknown = {}
      if (method === 'status.get') {
        if (options.unreadableStatus) {
          return { id: 'r', ok: true, result: {} }
        }
        result = {
          protocolVersion: 10,
          minCompatibleMobileVersion: 1,
          appVersion: '1.4.232',
          capabilities:
            options.legacyReceiver ||
            (options.legacyServingHost && !requestOptions?.envelope?.executionHost)
              ? []
              : ['bots.session-links.v1']
        }
      } else if (method === 'folderWorkspace.list') {
        if (options.refusedLinks) {
          return { id: 'r', ok: false, error: { code: 'failed', message: 'unreadable' } }
        }
        await options.waitForLinks
        if (options.reconnect) {
          generation += 1
        }
        result = {
          folderWorkspaces: [
            {
              id: 'home-1',
              externalConversations: [
                {
                  source: 'slack',
                  externalId: 'C1:123.4',
                  sessionId: 'lead-1',
                  paneKey: 'chat-pane',
                  ...(options.associated === false
                    ? {}
                    : { bot: { botId: 'atlas', kind: 'bot-chat' } })
                }
              ]
            }
          ]
        }
      } else if (method === 'orchestration.sessionWorkers') {
        result = {
          workers: [
            {
              dispatchId: 'dispatch-2',
              host: options.workerHost ?? 'local',
              chatSessionId: 'worker-2',
              worktreeId: 'worker-folder'
            }
          ]
        }
      } else if (method === 'orchestration.partyLocation') {
        result = {
          location: {
            kind: 'chat',
            sessionId: options.workerHost === 'local' ? 'worker-2' : 'lead-1',
            worktreeId: 'folder-1'
          }
        }
      }
      return { id: 'r', ok: true, result }
    }
  )
  const partial: Pick<RpcClient, 'sendRequest' | 'getState' | 'getGeneration' | 'onStateChange'> = {
    sendRequest: request,
    onStateChange: () => () => {},
    getState: () => 'connected',
    getGeneration: () => generation
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: locating only reads request, state and generation from the paired client.
  const client = partial as RpcClient
  return { request, client }
}

function disconnectable(client: RpcClient) {
  let state: ReturnType<RpcClient['getState']> = 'connected'
  const listeners = new Set<Parameters<RpcClient['onStateChange']>[0]>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper inherits the full real client contract and overrides only connection observation.
  const connected = Object.create(client) as RpcClient
  connected.getState = () => state
  connected.onStateChange = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    client: connected,
    disconnect: () => {
      state = 'disconnected'
      for (const listener of listeners) {
        listener(state)
      }
    }
  }
}

describe('paired bot session links', () => {
  it('settles a connected host that never finishes its lookup', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const waiting = new Promise<void>((done) => {
      release = done
    })
    try {
      const paired = host({ waitForLinks: waiting })
      const opening = locateBotSessionLink(target, [computer], () => paired.client)
      await vi.advanceTimersByTimeAsync(60_000)
      expect((await opening).kind).toBe('failed')
    } finally {
      release()
      vi.useRealTimers()
    }
  })

  it('settles a silent host lookup when it disconnects while another host has answered', async () => {
    let release!: () => void
    const waiting = new Promise<void>((done) => {
      release = done
    })
    const first = disconnectable(host({ associated: false }).client)
    const second = disconnectable(host({ waitForLinks: waiting }).client)
    const other = { ...computer, key: 'paired-2\nlocal', pairedHostId: 'paired-2' }
    const opening = locateBotSessionLink(target, [computer, other], (id) =>
      id === 'paired-1' ? first.client : second.client
    )
    // Both connections can vanish while the second RPC never acknowledges cancellation.
    first.disconnect()
    second.disconnect()
    expect(await opening).toEqual({ kind: 'missing' })
    release()
  })

  it('discards an already-answered Home after it disconnects while another host is pending', async () => {
    let release!: () => void
    const waiting = new Promise<void>((done) => {
      release = done
    })
    const firstHost = host({ associated: false })
    const first = disconnectable(firstHost.client)
    const second = host({ associated: false, waitForLinks: waiting })
    const other = { ...computer, key: 'paired-2\nlocal', pairedHostId: 'paired-2' }
    const opening = locateBotSessionLink(target, [computer, other], (id) =>
      id === 'paired-1' ? first.client : second.client
    )
    await locateBotSessionLink(target, [computer], () => first.client)
    first.disconnect()
    release()
    const result = await opening
    expect(result.kind === 'home' ? result.home.computer.pairedHostId : result.kind).toBe(
      'paired-2'
    )
  })
  it('cannot open a host absent from the paired client catalog', async () => {
    expect(await locateBotSessionLink(target, [computer], () => null)).toEqual({ kind: 'missing' })
  })

  it('requires a stored bot association before locating a targeted session', async () => {
    const paired = host({ associated: false })
    expect((await locateBotSessionLink(target, [computer], () => paired.client)).kind).toBe('home')
  })

  it('opens the exact item on the paired conversation', async () => {
    const paired = host()
    const found = await locateBotSessionLink(target, [computer], () => paired.client)
    expect(
      found.kind === 'open' ? [found.session.sessionId, found.session.itemId] : found.kind
    ).toEqual(['lead-1', 'question-2'])
  })

  it('requires the worker to belong to this conversation on the answering host', async () => {
    const paired = host({ workerHost: 'local' })
    const found = await locateBotSessionLink(
      { ...target, sessionId: 'worker-2' },
      [computer],
      () => paired.client
    )
    expect(
      found.kind === 'open' ? [found.session.sessionId, found.session.itemId] : found.kind
    ).toEqual(['worker-2', 'question-2'])
  })

  it('drops the item when a worker belongs to another host', async () => {
    const paired = host({ workerHost: 'remote' })
    const found = await locateBotSessionLink(
      { ...target, sessionId: 'worker-2' },
      [computer],
      () => paired.client
    )
    expect(
      found.kind === 'open' ? [found.session.sessionId, found.session.itemId] : found.kind
    ).toEqual(['lead-1', undefined])
  })

  it('does not turn an unreadable status into an update or Home opening', async () => {
    const paired = host({ unreadableStatus: true })
    expect((await locateBotSessionLink(target, [computer], () => paired.client)).kind).toBe(
      'failed'
    )
  })

  it('does not turn a refused association read into a Home opening', async () => {
    const paired = host({ refusedLinks: true })
    expect((await locateBotSessionLink(target, [computer], () => paired.client)).kind).toBe(
      'failed'
    )
  })

  it('requires the paired serving host to support a relayed server’s item links', async () => {
    const paired = host({ legacyServingHost: true })
    const relayed = { ...computer, executionHost: 'runtime:server' as const, serverLabel: 'Server' }
    const found = await locateBotSessionLink(target, [relayed], () => paired.client)
    expect(found.kind === 'update-needed' && found.servingHost).toBe(true)
  })

  it('opens a relayed item when both the serving computer and execution server support it', async () => {
    const paired = host()
    const relayed = { ...computer, executionHost: 'runtime:server' as const, serverLabel: 'Server' }
    const found = await locateBotSessionLink(target, [relayed], () => paired.client)
    expect(
      found.kind === 'open' ? [found.session.sessionId, found.session.itemId] : found.kind
    ).toEqual(['lead-1', 'question-2'])
  })

  it('discards a location from a superseded paired connection', async () => {
    const paired = host({ reconnect: true })
    expect(await locateBotSessionLink(target, [computer], () => paired.client)).toEqual({
      kind: 'missing'
    })
  })
  it('rechecks support after a capable inventory is followed by a host downgrade', async () => {
    const paired = host({ legacyReceiver: true })
    expect((await locateBotSessionLink(target, [computer], () => paired.client)).kind).toBe(
      'update-needed'
    )
  })
})
