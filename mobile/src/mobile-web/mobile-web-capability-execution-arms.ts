import {
  MobileWebSessionSubscribePayloadSchema,
  MobileWebWorkspaceSubscribePayloadSchema
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebBridgeCapability } from '../../../src/shared/mobile-web/bridge-operation-registry'
import { MobileWebSourceControlSubscribePayloadSchema } from '../../../src/shared/mobile-web/source-control-operation-contract'
import { MobileWebSpeechSubscribePayloadSchema } from '../../../src/shared/mobile-web/speech-operation-contract'
import { executeMobileWebAccountCapability } from './mobile-web-account-capability'
import { executeMobileWebAgentHistoryOperation } from './mobile-web-agent-history-operations'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { executeMobileWebBrowserOperation } from './mobile-web-browser-operations'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import { executeMobileWebFileOperation } from './mobile-web-file-operations'
import { executeMobileWebMarkdownOperation } from './mobile-web-markdown-operations'
import { executeMobileWebNavigationOperation } from './mobile-web-navigation-operations'
import { executeMobileWebNativeCapabilityOperation } from './mobile-web-native-capability-operations'
import { executeMobileWebNativeChatCapability } from './mobile-web-native-chat-capability'
import { executeMobileWebProviderOperation } from './mobile-web-provider-review-operations'
import { executeMobileWebProviderReviewDiff } from './mobile-web-provider-review-diff'
import { executeMobileWebSessionOperation } from './mobile-web-session-operations'
import { executeMobileWebSourceControlOperation } from './mobile-web-source-control-operations'
import { executeMobileWebSpeechOperation } from './mobile-web-speech-operations'
import { executeMobileWebTaskReadOperation } from './mobile-web-task-read-operations'
import { executeMobileWebWorkspaceOperation } from './mobile-web-workspace-operations'

type PageRequest = Extract<MobileWebBridgePageMessage, { type: 'request' }>
type OnceRequest = Extract<PageRequest, { mode: 'once' }>
type SubscriptionRequest = Extract<PageRequest, { mode: 'subscription' }>

type Deps = MobileWebCapabilityExecutionDependencies
type OnceArm = (args: Deps, request: OnceRequest) => Promise<unknown>
type SubscriptionArm = (args: Deps, request: SubscriptionRequest) => Promise<unknown>

/** A subscription arm only ever serves `subscribe`; the grant table has no other subscription
 * operation, and a page that asks for one must not fall through to a one-shot adapter. */
function requireSubscribeOperation(request: SubscriptionRequest): void {
  if (request.operation !== 'subscribe') {
    throw new MobileWebBrokerError('unsupported_capability')
  }
}

async function executeNative(args: Deps, request: OnceRequest): Promise<unknown> {
  return executeMobileWebNativeCapabilityOperation({
    operation: request.operation,
    payload: request.payload,
    authority: args.nativeAuthority,
    browserAuthority: args.browserAuthority,
    workspaceAuthority: args.workspaceAuthority
  })
}

async function executeNavigation(args: Deps, request: OnceRequest): Promise<unknown> {
  return executeMobileWebNavigationOperation({
    requestId: request.requestId,
    operation: request.operation,
    payload: request.payload,
    authority: args.navigationAuthority
  })
}

async function executeBrowser(args: Deps, request: OnceRequest): Promise<unknown> {
  return executeMobileWebBrowserOperation({
    operation: request.operation,
    payload: request.payload,
    client: args.connectedClient(),
    workspaceAuthority: args.workspaceAuthority,
    browserAuthority: args.browserAuthority
  })
}

async function executeWorkspace(args: Deps, request: OnceRequest): Promise<unknown> {
  if (request.capability !== 'workspace' && request.capability !== 'settings') {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  const result = await executeMobileWebWorkspaceOperation({
    capability: request.capability,
    operation: request.operation,
    payload: request.payload,
    client: args.connectedClient(),
    authority: args.workspaceAuthority,
    snapshots: args.workspaceSnapshots
  })
  if (request.capability === 'workspace' && request.operation === 'activate') {
    args.terminalArtifactAuthority.clear()
  }
  return result
}

async function executeSession(args: Deps, request: OnceRequest): Promise<unknown> {
  const result = await executeMobileWebSessionOperation({
    operation: request.operation,
    payload: request.payload,
    requestId: request.requestId,
    client: args.connectedClient(),
    workspaceAuthority: args.workspaceAuthority,
    browserAuthority: args.browserAuthority,
    nativeChatAuthority: args.nativeChatAuthority
  })
  if (
    request.operation === 'create' ||
    request.operation === 'createAgent' ||
    request.operation === 'createQuickCommand' ||
    request.operation === 'createBrowser' ||
    request.operation === 'activate' ||
    request.operation === 'close'
  ) {
    args.terminalArtifactAuthority.clear()
  }
  return result
}

async function executeTerminal(args: Deps, request: OnceRequest): Promise<unknown> {
  return args.terminalStreams.handle(request.payload, args.connectedClient())
}

async function executeFile(args: Deps, request: OnceRequest): Promise<unknown> {
  const client = args.connectedClient()
  if (request.operation.startsWith('markdown')) {
    return executeMobileWebMarkdownOperation({ ...args, ...request, client })
  }
  if (request.operation === 'resolveTerminalPath') {
    return args.terminalArtifactAuthority.resolve(request.payload, client, args.workspaceAuthority)
  }
  if (request.operation === 'readTerminalArtifactChunk') {
    return args.terminalArtifactAuthority.readChunk(request.payload, client)
  }
  if (request.operation === 'releaseTerminalArtifact') {
    return args.terminalArtifactAuthority.release(request.payload)
  }
  return executeMobileWebFileOperation({
    operation: request.operation,
    payload: request.payload,
    client,
    workspaceAuthority: args.workspaceAuthority
  })
}

async function executeProvider(args: Deps, request: OnceRequest): Promise<unknown> {
  if (request.operation === 'reviewDiff') {
    return executeMobileWebProviderReviewDiff(
      request.payload,
      args.connectedClient(),
      args.workspaceAuthority
    )
  }
  return executeMobileWebProviderOperation({
    operation: request.operation,
    payload: request.payload,
    client: args.connectedClient(),
    workspaceAuthority: args.workspaceAuthority
  })
}

async function executeSourceControl(args: Deps, request: OnceRequest): Promise<unknown> {
  if (request.operation === 'generateCommitMessage') {
    return args.commitMessageGeneration.generate({
      requestId: request.requestId,
      payload: request.payload,
      client: args.connectedClient(),
      workspaceAuthority: args.workspaceAuthority
    })
  }
  if (request.operation === 'cancelCommitMessageGeneration') {
    return args.commitMessageGeneration.cancel(
      request.payload,
      args.connectedClient(),
      args.workspaceAuthority
    )
  }
  return executeMobileWebSourceControlOperation({
    operation: request.operation,
    payload: request.payload,
    client: args.connectedClient(),
    workspaceAuthority: args.workspaceAuthority,
    branchComparePager: args.sourceControlBranchCompare,
    requestId: request.requestId,
    terminalClientId: args.terminalClientId
  })
}

async function executeSpeech(args: Deps, request: OnceRequest): Promise<unknown> {
  return executeMobileWebSpeechOperation({
    operation: request.operation,
    payload: request.payload,
    client: args.connectedClient(),
    authority: args.speechAuthority
  })
}

async function executeTask(args: Deps, request: OnceRequest): Promise<unknown> {
  return executeMobileWebTaskReadOperation({
    operation: request.operation,
    payload: request.payload,
    client: args.connectedClient(),
    authority: args.workspaceAuthority,
    targetAuthority: args.taskTargetAuthority,
    projectTable: args.taskProjectTable
  })
}

export const MOBILE_WEB_ONCE_CAPABILITY_ARMS: Partial<Record<MobileWebBridgeCapability, OnceArm>> =
  {
    native: executeNative,
    nativeChat: (args, request) => executeMobileWebNativeChatCapability(args, request),
    navigation: executeNavigation,
    agentHistory: (args) => executeMobileWebAgentHistoryOperation(args),
    account: (args) => executeMobileWebAccountCapability(args),
    browser: executeBrowser,
    workspace: executeWorkspace,
    settings: executeWorkspace,
    session: executeSession,
    terminal: executeTerminal,
    file: executeFile,
    provider: executeProvider,
    sourceControl: executeSourceControl,
    speech: executeSpeech,
    task: executeTask
  }

async function subscribeBrowser(args: Deps, request: SubscriptionRequest): Promise<unknown> {
  requireSubscribeOperation(request)
  args.browserStreams.start({
    requestId: request.requestId,
    subscriptionId: request.subscriptionId,
    payload: request.payload,
    client: args.connectedClient()
  })
  return null
}

async function subscribeWorkspace(args: Deps, request: SubscriptionRequest): Promise<unknown> {
  requireSubscribeOperation(request)
  MobileWebWorkspaceSubscribePayloadSchema.parse(request.payload)
  args.workspaceSubscriptions.start({
    requestId: request.requestId,
    subscriptionId: request.subscriptionId,
    client: args.connectedClient()
  })
  return null
}

async function subscribeSession(args: Deps, request: SubscriptionRequest): Promise<unknown> {
  requireSubscribeOperation(request)
  const payload = MobileWebSessionSubscribePayloadSchema.parse(request.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  args.sessionSubscriptions.start({
    requestId: request.requestId,
    subscriptionId: request.subscriptionId,
    pageWorkspaceId: payload.workspaceId,
    hostWorkspaceId,
    client: args.connectedClient()
  })
  return null
}

async function subscribeTerminal(args: Deps, request: SubscriptionRequest): Promise<unknown> {
  requireSubscribeOperation(request)
  await args.terminalStreams.start({
    requestId: request.requestId,
    subscriptionId: request.subscriptionId,
    payload: request.payload,
    client: args.connectedClient(),
    isRequestActive: args.isRequestActive
  })
  return null
}

async function subscribeSpeech(args: Deps, request: SubscriptionRequest): Promise<unknown> {
  requireSubscribeOperation(request)
  MobileWebSpeechSubscribePayloadSchema.parse(request.payload)
  args.speechAuthority.subscribe({
    requestId: request.requestId,
    subscriptionId: request.subscriptionId
  })
  return null
}

async function subscribeSourceControl(args: Deps, request: SubscriptionRequest): Promise<unknown> {
  requireSubscribeOperation(request)
  const payload = MobileWebSourceControlSubscribePayloadSchema.parse(request.payload)
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
  args.sourceControlSubscriptions.start({
    requestId: request.requestId,
    subscriptionId: request.subscriptionId,
    pageWorkspaceId: payload.workspaceId,
    hostWorkspaceId,
    client: args.connectedClient()
  })
  return null
}

export const MOBILE_WEB_SUBSCRIPTION_CAPABILITY_ARMS: Partial<
  Record<MobileWebBridgeCapability, SubscriptionArm>
> = {
  nativeChat: (args, request) => executeMobileWebNativeChatCapability(args, request),
  account: (args) => executeMobileWebAccountCapability(args),
  browser: subscribeBrowser,
  workspace: subscribeWorkspace,
  session: subscribeSession,
  terminal: subscribeTerminal,
  speech: subscribeSpeech,
  sourceControl: subscribeSourceControl
}
