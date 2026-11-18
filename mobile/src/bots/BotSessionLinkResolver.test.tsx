import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { BotSessionLinkResolver } from './BotSessionLinkResolver'
import { readHostStatusReply } from '../query/host-status-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

const view: {
  client: RpcClient | null
  cancel: () => void
  open: ReturnType<typeof vi.fn>
  alert: ReturnType<typeof vi.fn>
  translate: (key: string, fallback: string) => string
  router: { push: ReturnType<typeof vi.fn> }
} = vi.hoisted(() => ({
  client: null,
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
vi.mock('./use-bot-link-host-answers', () => {
  const computer = {
    key: 'paired\nlocal',
    pairedHostId: 'paired',
    executionHost: 'local',
    answer: { kind: 'bots', bots: [{ id: 'bot', name: 'Bot', folderWorkspaceId: 'home' }] }
  }
  const answers = {
    hosts: [{ id: 'paired', name: 'Studio' }],
    answers: [],
    computers: new Map([[computer.key, computer]]),
    clientFor: () => view.client,
    failed: false
  }
  return { useBotLinkHostAnswers: () => answers }
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
            target: {
              kind: 'session',
              botId: 'bot',
              conversation: { source: 'slack', externalId: 'C:1' },
              sessionId: 'lead'
            },
            onDone: done
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
