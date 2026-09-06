import { describe, expect, it, vi } from 'vitest'
import type { MobileWebSubscriptionClosure } from './mobile-web-subscription-closure'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebAccountSubscriptions } from './mobile-web-account-subscriptions'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebBrowserStreams } from './mobile-web-browser-streams'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebNativeChatSubscriptions } from './mobile-web-native-chat-subscriptions'
import { MobileWebSessionSubscriptions } from './mobile-web-session-subscriptions'
import { MobileWebSourceControlSubscriptions } from './mobile-web-source-control-subscriptions'
import { MobileWebSpeechSubscriptions } from './mobile-web-speech-subscriptions'
import type { MobileWebSpeechEvent } from '../../../src/shared/mobile-web/speech-operation-contract'
import { MobileWebWorkspaceSubscriptions } from './mobile-web-workspace-subscriptions'
import {
  mobileWebHostWorkspaceIdFromHost,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

const SUBSCRIPTION_ID = 'subscription-1'
const HOST_WORKSPACE = mobileWebHostWorkspaceIdFromHost('workspace-1')

type Posts = {
  isActive: () => boolean
  postEvent: (subscriptionId: string, sequence: number, event: unknown) => Promise<void>
  postClosed: (subscriptionId: string, closure: MobileWebSubscriptionClosure) => void
}

type LedgerCase = {
  name: string
  // Browser drops an unparseable frame instead of retiring, so it has no invalid-message closure.
  invalidCode: 'invalid_message' | null
  invalid: unknown
  valid: unknown
  open: (posts: Posts) => Promise<(value: unknown) => void>
}

function randomBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(4)
}

function hostClient(): { client: RpcClient; emit: (value: unknown) => void } {
  let listener: ((value: unknown) => void) | undefined
  const client = {
    subscribe: vi.fn((_method: string, _params: unknown, onEvent: (value: unknown) => void) => {
      listener = onEvent
      return () => {}
    }),
    sendRequest: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        tabs: [
          {
            type: 'terminal',
            id: 'tab-1',
            terminal: 'terminal-1',
            launchAgent: 'claude',
            agentStatus: { agentType: 'claude', providerSession: { id: 'provider-session-1' } }
          }
        ]
      }
    })
  } as unknown as RpcClient
  return { client, emit: (value) => listener?.(value) }
}

function pageWorkspace(): { authority: MobileWebWorkspaceAuthority; pageWorkspaceId: string } {
  const authority = new MobileWebWorkspaceAuthority(randomBytes)
  authority.synchronize([{ workspaceId: 'workspace-1', repoId: 'repo-1' }])
  return { authority, pageWorkspaceId: authority.pageWorkspaceId('workspace-1') }
}

const LEDGER_CASES: LedgerCase[] = [
  {
    name: 'account',
    invalidCode: 'invalid_message',
    invalid: { type: 'bogus' },
    valid: { type: 'end' },
    open: async (posts) => {
      const host = hostClient()
      new MobileWebAccountSubscriptions(posts).start({
        requestId: 'request-1',
        subscriptionId: SUBSCRIPTION_ID,
        client: host.client
      })
      return host.emit
    }
  },
  {
    name: 'workspace',
    invalidCode: 'invalid_message',
    invalid: { type: 'bogus' },
    valid: { type: 'end' },
    open: async (posts) => {
      const host = hostClient()
      new MobileWebWorkspaceSubscriptions(posts).start({
        requestId: 'request-1',
        subscriptionId: SUBSCRIPTION_ID,
        client: host.client
      })
      return host.emit
    }
  },
  {
    name: 'session',
    invalidCode: 'invalid_message',
    invalid: { worktree: 'workspace-other' },
    valid: {
      worktree: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 1,
      tabs: []
    },
    open: async (posts) => {
      const host = hostClient()
      const { pageWorkspaceId } = pageWorkspace()
      new MobileWebSessionSubscriptions({
        ...posts,
        browserAuthority: new MobileWebBrowserAuthority(randomBytes),
        nativeChatAuthority: new MobileWebNativeChatAuthority(randomBytes)
      }).start({
        requestId: 'request-1',
        subscriptionId: SUBSCRIPTION_ID,
        pageWorkspaceId,
        hostWorkspaceId: HOST_WORKSPACE,
        client: host.client
      })
      return host.emit
    }
  },
  {
    name: 'sourceControl',
    invalidCode: 'invalid_message',
    invalid: { type: 'bogus' },
    valid: { type: 'changed', worktree: 'id:workspace-1', events: [] },
    open: async (posts) => {
      const host = hostClient()
      const { authority, pageWorkspaceId } = pageWorkspace()
      new MobileWebSourceControlSubscriptions({
        ...posts,
        workspaceAuthority: authority
      }).start({
        requestId: 'request-1',
        subscriptionId: SUBSCRIPTION_ID,
        pageWorkspaceId,
        hostWorkspaceId: 'workspace-1',
        client: host.client
      })
      return host.emit
    }
  },
  {
    name: 'nativeChat',
    invalidCode: 'invalid_message',
    invalid: { type: 'bogus' },
    valid: { type: 'appended', messages: [] },
    open: async (posts) => {
      const host = hostClient()
      const { authority, pageWorkspaceId } = pageWorkspace()
      const nativeChatAuthority = new MobileWebNativeChatAuthority(randomBytes)
      const sessionId = nativeChatAuthority.register({
        hostWorkspaceId: 'workspace-1',
        hostTabId: 'tab-1',
        hostTerminalId: 'terminal-1',
        agent: 'claude',
        providerSessionId: 'provider-session-1'
      })
      await new MobileWebNativeChatSubscriptions({
        ...posts,
        nativeChatAuthority,
        workspaceAuthority: authority
      }).start({
        requestId: 'request-1',
        subscriptionId: SUBSCRIPTION_ID,
        payload: { workspaceId: pageWorkspaceId, sessionId, limit: 40 },
        client: host.client,
        isRequestActive: () => true
      })
      return host.emit
    }
  },
  {
    name: 'browser',
    invalidCode: null,
    invalid: { type: 'bogus' },
    valid: {
      type: 'ready',
      browserPageId: 'raw-page',
      tab: { url: 'https://example.com', title: 'Example', canGoBack: false, canGoForward: false }
    },
    open: async (posts) => {
      const host = hostClient()
      const { authority, pageWorkspaceId } = pageWorkspace()
      const browserAuthority = new MobileWebBrowserAuthority(randomBytes)
      new MobileWebBrowserStreams({
        ...posts,
        workspaceAuthority: authority,
        browserAuthority
      }).start({
        requestId: 'request-1',
        subscriptionId: SUBSCRIPTION_ID,
        payload: {
          workspaceId: pageWorkspaceId,
          pageId: browserAuthority.register('workspace-1', 'raw-page'),
          format: 'jpeg',
          quality: 72,
          maxWidth: 800,
          maxHeight: 600,
          everyNthFrame: 1,
          minFrameIntervalMs: 100
        },
        client: host.client
      })
      return host.emit
    }
  },
  {
    name: 'speech',
    // Push-driven from the shell's dictation runtime, so no host frame can be unusable.
    invalidCode: null,
    invalid: { status: 'bogus' },
    valid: { status: 'recording' },
    open: async (posts) => {
      const subscriptions = new MobileWebSpeechSubscriptions(posts)
      subscriptions.start({ requestId: 'request-1', subscriptionId: SUBSCRIPTION_ID })
      return (value) => subscriptions.post(value as MobileWebSpeechEvent)
    }
  }
]

// Ledgers that retire on an unusable host message; browser drops the frame instead, so it is absent.
const RETIRING_LEDGER_CASES = LEDGER_CASES.filter(
  (ledger): ledger is LedgerCase & { invalidCode: 'invalid_message' } => ledger.invalidCode !== null
)

// Without a terminal frame the page keeps a live subscription and freezes on its last value.
describe('shell subscription ledgers publish a closure frame when they retire early', () => {
  it.each(RETIRING_LEDGER_CASES)(
    'closes the $name subscription on an unusable host message',
    async (ledger) => {
      const closures: [string, MobileWebSubscriptionClosure][] = []
      const emit = await ledger.open({
        isActive: () => true,
        postEvent: async () => {},
        postClosed: (subscriptionId, closure) => closures.push([subscriptionId, closure])
      })

      emit(ledger.invalid)

      expect(closures).toEqual([[SUBSCRIPTION_ID, { code: ledger.invalidCode, retryable: false }]])
    }
  )

  it.each(LEDGER_CASES)(
    'closes the $name subscription when the page post fails',
    async (ledger) => {
      const closures: [string, MobileWebSubscriptionClosure][] = []
      const emit = await ledger.open({
        isActive: () => true,
        postEvent: async () => {
          throw new Error('page gone')
        },
        postClosed: (subscriptionId, closure) => closures.push([subscriptionId, closure])
      })

      emit(ledger.valid)
      await vi.waitFor(() => expect(closures).toHaveLength(1))

      expect(closures[0]).toEqual([SUBSCRIPTION_ID, { code: 'unavailable', retryable: true }])
    }
  )
})
