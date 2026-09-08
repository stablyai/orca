import { MobileWebHostRequestClient } from './mobile-web-host-request-client'
import { mobileWebHostRpcSender, type MobileWebHostRpcSender } from './mobile-web-host-rpc-sender'
import {
  subscribeHostSourceControl,
  type MobileWebSourceControlSubscriptionArgs
} from './mobile-web-source-control-host-subscription'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgeMessageContext,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import type {
  MobileWebSessionSnapshotResult,
  MobileWebSessionSubscribePayload,
  MobileWebWorkspaceChange
} from '../../shared/mobile-web/bridge-operation-contract'
import type {
  MobileWebTerminalEvent,
  MobileWebTerminalRequest
} from '../../shared/mobile-web/terminal-stream-contract'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type {
  MobileWebBrowserEvent,
  MobileWebBrowserStreamPayload
} from '../../shared/mobile-web/browser-operation-contract'
import type { MobileWebBrowserRequestClient } from './mobile-web-browser-request-client'
import { mobileWebBrowserNavigationClientBindings } from './mobile-web-browser-navigation-client-bindings'
import { subscribeMobileWebHostBrowser } from './mobile-web-host-browser-subscription'
import { MobileWebAccountRequestClient } from './mobile-web-account-request-client'
import { MobileWebAgentHistoryRequestClient } from './mobile-web-agent-history-request-client'
import { mobileWebFileClientBindings } from './mobile-web-file-client-bindings'
import { MobileWebFileRequestClient } from './mobile-web-file-request-client'
import { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import type {
  MobileWebBridgeSubscription,
  MobileWebTerminalBridgeSubscription
} from './mobile-web-bridge-subscription'
import { uniqueMobileWebMessageId } from './mobile-web-message-id'
import { mobileWebBridgeOperationKey } from './mobile-web-bridge-request-state'
import { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import { MobileWebNativeRequestClient } from './mobile-web-native-request-client'
import { MobileWebNativeChatRequestClient } from './mobile-web-native-chat-request-client'
import { MobileWebMarkdownRequestClient } from './mobile-web-markdown-request-client'
import type { MobileWebNavigationRequestClient } from './mobile-web-navigation-request-client'
import type { MobileWebProviderReviewRequestClient } from './mobile-web-provider-review-request-client'
import type { MobileWebProviderReviewCreationRequestClient } from './mobile-web-provider-review-creation-request-client'
import { mobileWebReviewClientBindings } from './mobile-web-review-client-bindings'
import { mobileWebSessionClientBindings } from './mobile-web-session-client-bindings'
import { MobileWebSessionRequestClient } from './mobile-web-session-request-client'
import { mobileWebSourceControlClientBindings } from './mobile-web-source-control-client-bindings'
import { MobileWebCommitMessageRequestClient } from './mobile-web-commit-message-request-client'
import { MobileWebSourceControlRequestClient } from './mobile-web-source-control-request-client'
import type { MobileWebSourceControlReviewRequestClient } from './mobile-web-source-control-review-request-client'
import { MobileWebSourceControlSyncRequestClient } from './mobile-web-source-control-sync-request-client'
import { MobileWebSpeechRequestClient } from './mobile-web-speech-request-client'
import * as terminal from './mobile-web-terminal-request-client'
import { mobileWebWorkspaceClientBindings } from './mobile-web-workspace-client-bindings'
import { MobileWebWorkspaceRequestClient } from './mobile-web-workspace-request-client'
import { MobileWebWorkspaceCreationCreateRequestClient } from './mobile-web-workspace-creation-create-request-client'

type InitMessage = Extract<MobileWebBridgeShellMessage, { type: 'init' }>
type OperationGrant = InitMessage['grants'][number]
export { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

export class MobileWebBridgeClient {
  private readonly grants = new Map<string, OperationGrant>()
  private readonly requests: MobileWebOneShotRequestClient
  readonly host: MobileWebHostRequestClient
  readonly hostRpcSender: MobileWebHostRpcSender
  readonly fileList!: MobileWebFileRequestClient['list']
  readonly fileSearch!: MobileWebFileRequestClient['search']
  readonly fileDirectory!: MobileWebFileRequestClient['directory']
  readonly fileRead!: MobileWebFileRequestClient['read']
  readonly fileReadChunk!: MobileWebFileRequestClient['readChunk']
  readonly fileWrite!: MobileWebFileRequestClient['write']
  readonly fileOpen!: MobileWebFileRequestClient['open']
  readonly hostSubscribe: MobileWebBridgeSubscriptionClient['subscribeHost']
  readonly fileResolveTerminalPath!: MobileWebFileRequestClient['resolveTerminalPath']
  readonly fileReadTerminalArtifactChunk!: MobileWebFileRequestClient['readTerminalArtifactChunk']
  readonly sourceControlStatus!: MobileWebSourceControlRequestClient['status']
  readonly sourceControlDiff!: MobileWebSourceControlRequestClient['diff']
  readonly sourceControlBranches!: MobileWebSourceControlRequestClient['branches']
  readonly sourceControlHistory!: MobileWebSourceControlRequestClient['history']
  readonly sourceControlBranchCompare!: MobileWebSourceControlRequestClient['branchCompare']
  readonly sourceControlCommitCompare!: MobileWebSourceControlRequestClient['commitCompare']
  readonly sourceControlStage!: MobileWebSourceControlRequestClient['stage']
  readonly sourceControlUnstage!: MobileWebSourceControlRequestClient['unstage']
  readonly sourceControlDiscard!: MobileWebSourceControlRequestClient['discard']
  readonly sourceControlCommit!: MobileWebSourceControlRequestClient['commit']
  readonly sourceControlGenerateCommitMessage!: MobileWebCommitMessageRequestClient['generate']
  readonly sourceControlCancelCommitMessageGeneration!: MobileWebCommitMessageRequestClient['cancel']
  readonly sourceControlRepositoryState!: MobileWebSourceControlSyncRequestClient['repositoryState']
  readonly sourceControlCheckout!: MobileWebSourceControlSyncRequestClient['checkout']
  readonly sourceControlFetch!: MobileWebSourceControlSyncRequestClient['fetch']
  readonly sourceControlPull!: MobileWebSourceControlSyncRequestClient['pull']
  readonly sourceControlPush!: MobileWebSourceControlSyncRequestClient['push']
  readonly sourceControlRebase!: MobileWebSourceControlSyncRequestClient['rebase']
  readonly sourceControlAbort!: MobileWebSourceControlSyncRequestClient['abort']
  readonly sourceControlReviewMetadata!: MobileWebSourceControlReviewRequestClient['metadata']
  readonly sourceControlReviewMetadataUpdate!: MobileWebSourceControlReviewRequestClient['metadataUpdate']
  readonly sourceControlReviewLink!: MobileWebSourceControlReviewRequestClient['link']
  readonly sourceControlReviewLinkUpdate!: MobileWebSourceControlReviewRequestClient['linkUpdate']
  readonly sourceControlReviewDiff!: MobileWebSourceControlReviewRequestClient['diff']
  readonly sourceControlReviewOpen!: MobileWebSourceControlReviewRequestClient['open']
  readonly sourceControlReviewTerminalSend!: MobileWebSourceControlReviewRequestClient['terminalSend']
  readonly providerReview!: MobileWebProviderReviewRequestClient['review']
  readonly providerReviewCreationEligibility!: MobileWebProviderReviewCreationRequestClient['eligibility']
  readonly providerReviewCreate!: MobileWebProviderReviewCreationRequestClient['create']
  readonly providerReviewGenerateFields!: MobileWebProviderReviewCreationRequestClient['generateFields']
  readonly providerReviewDiff!: MobileWebProviderReviewRequestClient['reviewDiff']
  readonly providerReviewQuery!: MobileWebProviderReviewRequestClient['reviewQuery']
  readonly providerMutateReview!: MobileWebProviderReviewRequestClient['mutateReview']
  readonly providerManageReview!: MobileWebProviderReviewRequestClient['manageReview']
  readonly providerSubmitReview!: MobileWebProviderReviewRequestClient['submitReview']
  readonly workspaceSnapshot!: MobileWebWorkspaceRequestClient['snapshot']
  readonly workspaceActivate!: MobileWebWorkspaceRequestClient['activate']
  readonly workspaceRepositories!: MobileWebWorkspaceRequestClient['repositories']
  readonly workspaceUpdate!: MobileWebWorkspaceRequestClient['update']
  readonly workspaceRemove!: MobileWebWorkspaceRequestClient['remove']
  readonly workspaceSettingsSnapshot!: MobileWebWorkspaceRequestClient['settingsSnapshot']
  readonly workspaceSettingsUpdate!: MobileWebWorkspaceRequestClient['settingsUpdate']
  readonly workspaceCreationCreate: MobileWebWorkspaceCreationCreateRequestClient
  readonly navigationRoute!: MobileWebNavigationRequestClient['route']
  readonly navigationReconnect!: MobileWebNavigationRequestClient['reconnect']
  readonly navigationRemoveHost!: MobileWebNavigationRequestClient['removeHost']
  readonly sessionCapabilities!: MobileWebSessionRequestClient['capabilities']
  readonly sessionHostGates!: MobileWebSessionRequestClient['hostGates']
  readonly sessionSnapshot!: MobileWebSessionRequestClient['snapshot']
  readonly sessionActivate!: MobileWebSessionRequestClient['activate']
  readonly sessionAgentOptions!: MobileWebSessionRequestClient['agentOptions']
  readonly sessionQuickCommands!: MobileWebSessionRequestClient['quickCommands']
  readonly sessionQuickCommandMutate!: MobileWebSessionRequestClient['quickCommandMutate']
  readonly sessionCreate!: MobileWebSessionRequestClient['create']
  readonly sessionCreateAgent!: MobileWebSessionRequestClient['createAgent']
  readonly sessionCreateQuickCommand!: MobileWebSessionRequestClient['createQuickCommand']
  readonly sessionCreateBrowser!: MobileWebSessionRequestClient['createBrowser']
  readonly sessionClose!: MobileWebSessionRequestClient['close']
  readonly native: MobileWebNativeRequestClient
  readonly nativeChat: MobileWebNativeChatRequestClient
  readonly markdown: MobileWebMarkdownRequestClient
  readonly account: MobileWebAccountRequestClient
  readonly agentHistory: MobileWebAgentHistoryRequestClient
  readonly speech: MobileWebSpeechRequestClient
  readonly prepareTerminalActions!: terminal.MobileWebTerminalRequestClient['prepareActions']
  readonly terminalRequest!: terminal.MobileWebTerminalRequestClient['request']
  readonly terminalDeviceInputRequest!: terminal.MobileWebTerminalRequestClient['deviceInput']
  readonly browserNavigate!: MobileWebBrowserRequestClient['navigate']
  readonly browserPointer!: MobileWebBrowserRequestClient['pointer']
  readonly browserKeyboard!: MobileWebBrowserRequestClient['keyboard']
  readonly browserDialog!: MobileWebBrowserRequestClient['dialog']
  readonly browserBack!: MobileWebBrowserRequestClient['back']
  readonly browserForward!: MobileWebBrowserRequestClient['forward']
  readonly browserReload!: MobileWebBrowserRequestClient['reload']
  private readonly subscriptions: MobileWebBridgeSubscriptionClient
  private disposed = false

  constructor(
    private readonly options: {
      context: MobileWebBridgeMessageContext
      grants: InitMessage['grants']
      postMessage: (message: MobileWebBridgePageMessage) => boolean
      createRequestId?: () => string
      requestTimeoutMs?: number
    }
  ) {
    for (const grant of options.grants) {
      this.grants.set(mobileWebBridgeOperationKey(grant.capability, grant.operation), grant)
    }
    const envelope = () =>
      ({
        version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
        shellSessionId: options.context.shellSessionId,
        buildId: options.context.buildId
      }) as const
    this.requests = new MobileWebOneShotRequestClient({
      getGrant: (capability, operation) =>
        this.grants.get(mobileWebBridgeOperationKey(capability, operation)),
      postMessage: options.postMessage,
      envelope,
      createRequestId: () => this.uniqueMessageId(),
      otherPendingCount: () => this.subscriptions.pendingCount(),
      requestTimeoutMs: options.requestTimeoutMs
    })
    Object.assign(this, mobileWebFileClientBindings(new MobileWebFileRequestClient(this.requests)))
    const sourceControlRequests = new MobileWebSourceControlRequestClient(this.requests)
    const sourceControlSyncRequests = new MobileWebSourceControlSyncRequestClient(this.requests)
    const commitMessageRequests = new MobileWebCommitMessageRequestClient(this.requests)
    Object.assign(
      this,
      mobileWebSourceControlClientBindings(
        sourceControlRequests,
        sourceControlSyncRequests,
        commitMessageRequests
      )
    )
    Object.assign(this, mobileWebReviewClientBindings(this.requests))
    Object.assign(
      this,
      mobileWebWorkspaceClientBindings(new MobileWebWorkspaceRequestClient(this.requests))
    )
    this.workspaceCreationCreate = new MobileWebWorkspaceCreationCreateRequestClient(this.requests)
    const sessionRequests = new MobileWebSessionRequestClient(this.requests)
    Object.assign(this, mobileWebSessionClientBindings(sessionRequests))
    this.native = new MobileWebNativeRequestClient(this.requests)
    this.markdown = new MobileWebMarkdownRequestClient(this.requests)
    this.host = new MobileWebHostRequestClient(this.requests)
    this.hostRpcSender = mobileWebHostRpcSender(this.requests)
    Object.assign(this, terminal.mobileWebTerminalClientBindings(this.requests))
    Object.assign(this, mobileWebBrowserNavigationClientBindings(this.requests))
    this.subscriptions = new MobileWebBridgeSubscriptionClient({
      getGrant: (capability, operation = 'subscribe') =>
        this.grants.get(mobileWebBridgeOperationKey(capability, operation)),
      postMessage: options.postMessage,
      envelope,
      createMessageId: (excluded) => this.uniqueMessageId(excluded),
      otherPendingCount: () => this.requests.pendingCount(),
      requestTimeoutMs: options.requestTimeoutMs
    })
    this.nativeChat = new MobileWebNativeChatRequestClient(this.requests, this.subscriptions)
    this.hostSubscribe = this.subscriptions.subscribeHost.bind(this.subscriptions)
    this.account = new MobileWebAccountRequestClient(this.requests, this.subscriptions)
    this.agentHistory = new MobileWebAgentHistoryRequestClient(this.requests)
    this.speech = new MobileWebSpeechRequestClient(this.requests, this.subscriptions)
  }

  workspaceSubscribe(
    onEvent: (event: MobileWebWorkspaceChange) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebBridgeSubscription {
    return this.subscriptions.subscribeWorkspace(onEvent, onError)
  }

  sessionSubscribe(
    payload: MobileWebSessionSubscribePayload,
    onEvent: (snapshot: MobileWebSessionSnapshotResult) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebBridgeSubscription {
    return this.subscriptions.subscribe(payload, onEvent, onError)
  }

  terminalSubscribe(
    payload: Extract<MobileWebTerminalRequest, { operation: 'subscribe' }>,
    onEvent: (event: MobileWebTerminalEvent) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebTerminalBridgeSubscription {
    return this.subscriptions.subscribeTerminal(payload, onEvent, onError)
  }

  sourceControlSubscribe(
    ...args: MobileWebSourceControlSubscriptionArgs
  ): MobileWebBridgeSubscription {
    return subscribeHostSourceControl(this.subscriptions, ...args)
  }

  browserSubscribe(
    payload: MobileWebBrowserStreamPayload,
    onEvent: (event: MobileWebBrowserEvent) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebBridgeSubscription {
    return subscribeMobileWebHostBrowser(this.subscriptions, payload, onEvent, onError)
  }

  receive(message: MobileWebBridgeShellMessage): void {
    if (!this.disposed && !this.subscriptions.receive(message)) {
      this.requests.receive(message)
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.subscriptions.dispose()
    this.requests.dispose()
  }

  private uniqueMessageId(excluded?: string): string {
    return uniqueMobileWebMessageId(
      this.options.createRequestId,
      (id) => this.requests.hasMessageId(id) || this.subscriptions.hasMessageId(id),
      excluded
    )
  }
}
