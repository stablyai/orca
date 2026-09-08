import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebBridgeCapability } from '../../../src/shared/mobile-web/bridge-operation-registry'
import { MobileWebSpeechSubscribePayloadSchema } from '../../../src/shared/mobile-web/speech-operation-contract'
import { executeWorkspace } from './mobile-web-workspace-capability'
import { executeMobileWebAccountCapability } from './mobile-web-account-capability'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import { executeMobileWebMarkdownDraftOperation } from './mobile-web-markdown-draft-operations'
import { executeMobileWebNavigationOperation } from './mobile-web-navigation-operations'
import { executeMobileWebNativeCapabilityOperation } from './mobile-web-native-capability-operations'
import { executeMobileWebNativeChatCapability } from './mobile-web-native-chat-capability'
import { executeMobileWebSpeechOperation } from './mobile-web-speech-operations'

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
    workspaceAuthority: args.workspaceAuthority
  })
}

async function executeNavigation(args: Deps, request: OnceRequest): Promise<unknown> {
  return executeMobileWebNavigationOperation({
    operation: request.operation,
    payload: request.payload,
    authority: args.navigationAuthority
  })
}

async function executeTerminal(args: Deps, request: OnceRequest): Promise<unknown> {
  return args.terminalStreams.handle(request.payload, args.connectedClient())
}

async function executeFile(args: Deps, request: OnceRequest): Promise<unknown> {
  return executeMobileWebMarkdownDraftOperation({
    operation: request.operation,
    payload: request.payload,
    workspaceAuthority: args.workspaceAuthority,
    nativeAuthority: args.nativeAuthority
  })
}

async function executeSourceControl(args: Deps, request: OnceRequest): Promise<unknown> {
  if (request.operation === 'cancelCommitMessageGeneration') {
    return args.commitMessageGeneration.cancel(
      request.payload,
      args.connectedClient(),
      args.workspaceAuthority
    )
  }
  if (request.operation === 'generateCommitMessage') {
    return args.commitMessageGeneration.generate({
      requestId: request.requestId,
      payload: request.payload,
      client: args.connectedClient(),
      workspaceAuthority: args.workspaceAuthority
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}

async function executeSpeech(args: Deps, request: OnceRequest): Promise<unknown> {
  return executeMobileWebSpeechOperation({
    operation: request.operation,
    payload: request.payload,
    client: args.connectedClient(),
    authority: args.speechAuthority
  })
}

export const MOBILE_WEB_ONCE_CAPABILITY_ARMS: Partial<Record<MobileWebBridgeCapability, OnceArm>> =
  {
    native: executeNative,
    nativeChat: (args, request) => executeMobileWebNativeChatCapability(args, request),
    navigation: executeNavigation,
    account: (args) => executeMobileWebAccountCapability(args),
    workspace: executeWorkspace,
    terminal: executeTerminal,
    file: executeFile,
    sourceControl: executeSourceControl,
    speech: executeSpeech
  }

async function subscribeWorkspace(args: Deps, request: SubscriptionRequest): Promise<unknown> {
  if (request.operation !== 'hostSubscribe') {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  args.hostSubscriptions.start({
    requestId: request.requestId,
    subscriptionId: request.subscriptionId,
    payload: request.payload,
    client: args.connectedClient(),
    isActive: args.isRequestActive
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

export const MOBILE_WEB_SUBSCRIPTION_CAPABILITY_ARMS: Partial<
  Record<MobileWebBridgeCapability, SubscriptionArm>
> = {
  workspace: subscribeWorkspace,
  terminal: subscribeTerminal,
  speech: subscribeSpeech
}
