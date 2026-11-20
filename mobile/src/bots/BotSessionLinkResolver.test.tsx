import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BotSessionLinkResolver } from './BotSessionLinkResolver'
import type { BotSessionLinkTarget } from './bot-link-target'
import { clearBotLink, publishBotLink, readPendingBotLink } from './pending-bot-link'
import { readHostStatusReply } from '../query/host-status-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

const view: {
  client: RpcClient | null
  clients: Record<string, RpcClient>
  executionHost: string
  hosts: { id: string; name: string }[]
  cancel: () => void
  open: ReturnType<typeof vi.fn>
  alert: ReturnType<typeof vi.fn>
  translate: (key: string, fallback: string) => string
  router: { push: ReturnType<typeof vi.fn> }
} = vi.hoisted(() => ({
  client: null,
  clients: {},
  executionHost: 'local',
  hosts: [{ id: 'paired', name: 'Studio' }],
  cancel: () => {},
  open: vi.fn(),
  alert: vi.fn(),
  translate: (_key: string, fallback: string) => fallback,
  router: { push: vi.fn() }
}))
vi.mock('react-native', () => ({ Alert: { alert: view.alert } }))
vi.mock('expo-router', () => ({ useRouter: () => view.router }))
vi.mock('../new-workspace/NewWorkspaceLoadingDrawer', () => ({
  NewWorkspaceLoadingDrawer: ({ onCancel }: { onCancel: () => void }) => {
    view.cancel = onCancel
    return null
  }
}))
vi.mock('../i18n/use-mobile-translation', () => ({ useMobileTranslation: () => view.translate }))
vi.mock('../session/use-open-mobile-session', () => ({ useOpenMobileSession: () => view.open }))
vi.mock('../session/native-chat/agent-session/open-mobile-structured-session', () => ({
  openMobileStructuredSession: async () => ({
    kind: 'opened',
    target: { worktreeId: 'folder-1' },
    tab: { id: 'tab-1' }
  })
}))
vi.mock('./use-bot-link-host-answers', () => {
  const computer = (pairedHostId: string) => ({
    key: `${pairedHostId}\n${view.executionHost}`,
    pairedHostId,
    executionHost: view.executionHost,
    answer: { kind: 'bots', bots: [{ id: 'bot', name: 'Bot', folderWorkspaceId: 'home' }] }
  })
  return {
    useBotLinkHostAnswers: () => ({
      hosts: view.hosts,
      answers: [],
      computers: new Map(view.hosts.map(({ id }) => [computer(id).key, computer(id)])),
      clientFor: (id: string) => (id === 'paired' ? view.client : (view.clients[id] ?? null)),
      failed: false
    })
  }
})

it.each(['cancel', 'unmount'] as const)(
  'stops abandoned lookup stages on %s without cancelling a shared status reader',
  async (mode) => {
    const requests: string[] = []
    let release!: (reply: RpcResponse) => void
    const waiting = new Promise<RpcResponse>((resolve) => {
      release = resolve
    })
    const partial: Pick<
      RpcClient,
      'getState' | 'getGeneration' | 'getLastConnectedAt' | 'onStateChange' | 'sendRequest'
    > = {
      getState: () => 'connected',
      getGeneration: () => 1,
      getLastConnectedAt: () => 2,
      onStateChange: () => () => {},
      sendRequest: async (method) => {
        requests.push(method)
        return method === 'status.get'
          ? waiting
          : { id: 'r', ok: true, result: { folderWorkspaces: [] } }
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the locator reads only status, RPC and connection observation from this fixture.
    view.client = partial as RpcClient
    const otherReader = readHostStatusReply(view.client)
    const done = vi.fn()
    let tree: ReturnType<typeof create> | undefined
    try {
      await act(async () => {
        tree = create(
          createElement(BotSessionLinkResolver, {
            ...publish({
              kind: 'session',
              botId: 'bot',
              conversation: { source: 'slack', externalId: 'C:1' },
              sessionId: 'lead'
            }),
            onDone: done,
            onFallBack: () => {}
          })
        )
      })
      await act(async () => {
        if (mode === 'cancel') {
          view.cancel()
        } else {
          tree?.unmount()
        }
      })
      await act(async () => {
        release({
          id: 'status',
          ok: true,
          result: {
            protocolVersion: 10,
            minCompatibleMobileVersion: 1,
            appVersion: '1.4.232',
            capabilities: ['bots.session-links.v1']
          }
        })
        await otherReader
      })
      expect(await otherReader).toMatchObject({ ok: true })
      expect(requests).not.toContain('folderWorkspace.list')
      expect(view.open).not.toHaveBeenCalled()
      expect(view.alert).not.toHaveBeenCalled()
      if (mode === 'cancel') {
        expect(done).toHaveBeenCalled()
      }
    } finally {
      await act(async () => tree?.unmount())
    }
  }
)

type Host = { client: RpcClient; requests: string[]; disconnect: () => void }

function answeringHost(
  options: {
    capable?: boolean
    thread?: boolean
    statusAnswered?: Promise<void>
    homeOpened?: Promise<void>
    /** The desktop's answer when the relayed server's connection was replaced under this request. */
    relayResetOn?: string
  } = {}
): Host {
  const requests: string[] = []
  let state: ReturnType<RpcClient['getState']> = 'connected'
  const partial: Pick<
    RpcClient,
    'getState' | 'getGeneration' | 'getLastConnectedAt' | 'onStateChange' | 'sendRequest'
  > = {
    getState: () => state,
    getGeneration: () => 1,
    getLastConnectedAt: () => 2,
    onStateChange: () => () => {},
    sendRequest: async (method, _params, requestOptions) => {
      requests.push(method)
      if (method === options.relayResetOn && requestOptions?.envelope?.executionHost) {
        return {
          id: 'r',
          ok: false,
          error: { code: 'remote_runtime_unavailable', message: 'The server connection was reset.' }
        }
      }
      if (method === 'status.get') {
        await options.statusAnswered
        return {
          id: 'r',
          ok: true,
          result: {
            protocolVersion: 10,
            minCompatibleMobileVersion: 1,
            appVersion: '1.4.232',
            capabilities: options.capable === false ? [] : ['bots.session-links.v1']
          }
        }
      }
      if (method === 'bots.chat.open') {
        await options.homeOpened
        return { id: 'r', ok: true, result: {} }
      }
      if (method === 'orchestration.partyLocation') {
        return {
          id: 'r',
          ok: true,
          result: { location: { kind: 'chat', sessionId: 'lead', worktreeId: 'folder-1' } }
        }
      }
      const link = { source: 'slack', externalId: 'C:1', sessionId: 'lead', paneKey: 'pane' }
      return {
        id: 'r',
        ok: true,
        result: {
          folderWorkspaces: [
            {
              id: 'home',
              externalConversations: options.thread
                ? [{ ...link, bot: { botId: 'bot', kind: 'bot-chat' } }]
                : []
            }
          ]
        }
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the locator reads only status, RPC and connection observation from this fixture.
  return { client: partial as RpcClient, requests, disconnect: () => (state = 'disconnected') }
}

function pairHosts(hosts: Record<string, Host>) {
  view.hosts = Object.keys(hosts).map((id) => ({ id, name: id }))
  view.clients = Object.fromEntries(Object.entries(hosts).map(([id, host]) => [id, host.client]))
  view.open.mockClear()
  view.alert.mockClear()
  onTestFinished(() => {
    view.hosts = [{ id: 'paired', name: 'Studio' }]
    view.clients = {}
  })
}

function publishNewerLink() {
  publishBotLink({ kind: 'bot', botId: 'newer' })
  const newer = readPendingBotLink()!
  onTestFinished(() => clearBotLink(newer.id))
}

function publish(target: BotSessionLinkTarget) {
  publishBotLink(target)
  const link = readPendingBotLink()!
  onTestFinished(() => clearBotLink(link.id))
  return { link, target }
}

function renderThread(hostKey?: string, sessionId?: string) {
  const done = vi.fn()
  const fallBack = vi.fn()
  let tree: ReturnType<typeof create> | undefined
  const rendered = act(async () => {
    tree = create(
      createElement(BotSessionLinkResolver, {
        ...publish({
          kind: 'session',
          botId: 'bot',
          conversation: { source: 'slack', externalId: 'C:1' },
          ...(hostKey ? { hostKey } : {}),
          ...(sessionId ? { sessionId } : {})
        }),
        onDone: done,
        onFallBack: fallBack
      })
    )
  })
  onTestFinished(() => act(async () => tree?.unmount()))
  return { done, fallBack, rendered, unmount: () => act(async () => tree?.unmount()) }
}

it('opens the thread on the computer picked for it, asking no other computer', async () => {
  const owner = answeringHost({ thread: true })
  const other = answeringHost()
  pairHosts({ owner, other })
  const { rendered, fallBack } = renderThread('owner\nlocal')
  await rendered
  expect(view.open).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: 'owner', worktreeId: 'folder-1' })
  )
  expect(other.requests).toEqual([])
  expect(fallBack).not.toHaveBeenCalled()
})

it('opens the bot Home, not another chat, on a picked computer without the thread', async () => {
  pairHosts({ owner: answeringHost({ thread: true }), other: answeringHost() })
  const { rendered } = renderThread('other\nlocal')
  await rendered
  expect(view.open).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: 'other', worktreeId: 'folder:home' })
  )
})

it('offers the computer choice when several computers list the bot', async () => {
  pairHosts({ owner: answeringHost({ thread: true }), other: answeringHost() })
  const { rendered, fallBack, done } = renderThread()
  await rendered
  expect(fallBack).toHaveBeenCalledTimes(1)
  expect(done).not.toHaveBeenCalled()
  expect(view.open).not.toHaveBeenCalled()
})

it.each([
  ['completes', true],
  ['is superseded', false],
  ['is replaced by a newer link before its resolver unmounts', false],
  ['loses its computer', false]
] as const)(
  'opens a thread link’s bot Home on an older computer only while the link %s',
  async (outcome, opens) => {
    let release!: () => void
    const host = answeringHost({
      capable: false,
      homeOpened: new Promise((resolve) => {
        release = resolve
      })
    })
    pairHosts({ only: host })
    const { rendered, unmount } = renderThread()
    await rendered
    if (outcome === 'is superseded') {
      await unmount()
    } else if (outcome === 'is replaced by a newer link before its resolver unmounts') {
      publishNewerLink()
    } else if (outcome === 'loses its computer') {
      host.disconnect()
    }
    await act(async () => release())
    expect(view.open.mock.calls.length > 0).toBe(opens)
  }
)

it('sends no Home request for a thread link replaced by a newer one mid-lookup', async () => {
  let answer!: () => void
  const host = answeringHost({
    capable: false,
    statusAnswered: new Promise((resolve) => {
      answer = resolve
    })
  })
  pairHosts({ only: host })
  const { rendered, done } = renderThread()
  await rendered
  publishNewerLink()
  await act(async () => answer())
  expect(host.requests).not.toContain('bots.chat.open')
  expect(view.open).not.toHaveBeenCalled()
  expect(done).not.toHaveBeenCalled()
})

it.each([
  ['stays current', 1],
  ['is replaced by a newer link before its resolver unmounts', 0]
] as const)('alerts about an older computer only while the link %s', async (outcome, alerts) => {
  let answer!: () => void
  pairHosts({
    only: answeringHost({
      capable: false,
      statusAnswered: new Promise((resolve) => {
        answer = resolve
      })
    })
  })
  const { rendered } = renderThread(undefined, 'lead')
  await rendered
  if (alerts === 0) {
    publishNewerLink()
  }
  await act(async () => answer())
  expect(view.alert).toHaveBeenCalledTimes(alerts)
})

it.each([
  ['the link was cleared as usual', false],
  ['a newer link came and was cleared again', true]
] as const)('lets Pair open pairing only while no newer link came: %s', async (_, newer) => {
  pairHosts({})
  view.router.push.mockClear()
  const { rendered, done } = renderThread()
  await rendered
  expect(done).toHaveBeenCalledTimes(1)
  if (newer) {
    publishBotLink({ kind: 'bot', botId: 'newer' })
    clearBotLink(readPendingBotLink()!.id)
  }
  const buttons: { onPress?: () => void }[] = view.alert.mock.calls[0][2]
  buttons.forEach((button) => button.onPress?.())
  expect(view.router.push.mock.calls).toEqual(newer ? [] : [['/pair']])
})

function relayThroughDesktop() {
  view.executionHost = 'runtime:server'
  onTestFinished(() => {
    view.executionHost = 'local'
  })
}

// Regression controls for a relayed server whose connection the desktop replaced mid-step while the
// paired connection stayed up: the desktop refuses in-flight requests, and no attempt retries.
it.each(['folderWorkspace.list', 'orchestration.partyLocation'])(
  'ends a session link with one line when its relayed server resets during %s; a fresh attempt opens',
  async (relayResetOn) => {
    relayThroughDesktop()
    pairHosts({ desk: answeringHost({ thread: true, relayResetOn }) })
    await renderThread(undefined, 'lead').rendered
    expect(view.alert).toHaveBeenCalledTimes(1)
    expect(view.open).not.toHaveBeenCalled()

    pairHosts({ desk: answeringHost({ thread: true }) })
    await renderThread(undefined, 'lead').rendered
    expect(view.alert).not.toHaveBeenCalled()
    expect(view.open).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'desk', worktreeId: 'folder-1' })
    )
  }
)
