import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { PairingOffer } from '../../shared/pairing'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRpcResponse
} from '../../shared/runtime-rpc-envelope'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { markEnvironmentUsed, resolveEnvironment } from '../../shared/runtime-environment-store'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import { withRemoteRuntimeTailscaleHint } from '../../shared/remote-runtime-tailscale-hint'
import {
  isRuntimeEnvironmentCapabilityOutcomeCurrent,
  type RuntimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'
import { runtimeEnvironmentRevisionFailure } from './runtime-environment-revision-guard'
import {
  clearSharedControlSupport,
  supportsSharedControl
} from './runtime-environment-shared-control-support'
import {
  sendRemoteRuntimeRequestAbortable,
  sendRemoteRuntimeSharedControlRequestAbortable
} from './runtime-environment-abortable-requests'
import { subscribeRemoteRuntimeSharedControlRequest } from './runtime-environment-request-connections'

type SupportRoute = {
  environment: KnownRuntimeEnvironment
  pairing: PairingOffer
  outcome: Exclude<RuntimeEnvironmentCapabilityOutcome, { kind: 'stale_incarnation' }>
}

type SubscriptionCallbacks = {
  onEvent: (
    payload:
      | { type: 'response'; response: RuntimeRpcResponse<unknown> }
      | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
      | { type: 'error'; code: string; message: string }
      | { type: 'close' }
  ) => void
  onClose: () => void
}

export function shouldRouteCallBySupport(method: string): boolean {
  // Snapshot recovery must stay available while shared-control streams reconnect after a restart.
  return (
    method !== 'status.get' && method !== 'session.tabs.list' && method !== 'session.tabs.listAll'
  )
}

export function shouldRouteSubscriptionBySupport(method: string): boolean {
  if (method === 'browser.screencast' || method === 'terminal.multiplex') {
    return false
  }
  return (
    method === 'runtime.clientEvents.subscribe' ||
    method === 'session.tabs.subscribe' ||
    method === 'session.tabs.subscribeAll' ||
    method === 'accounts.subscribe' ||
    method === 'notifications.subscribe' ||
    method === 'files.watch'
  )
}

export function executeSupportRoutedCall(args: {
  userDataPath: string
  environment: KnownRuntimeEnvironment
  method: string
  params: unknown
  timeoutMs: number
  expectedPairingRevision?: number
  envelope?: RuntimeOrchestrationEnvelope
  signal?: AbortSignal
}): Promise<RuntimeRpcResponse<unknown>> {
  return routeRuntimeEnvironmentCallBySupport({
    userDataPath: args.userDataPath,
    initialEnvironment: args.environment,
    method: args.method,
    timeoutMs: args.timeoutMs,
    expectedPairingRevision: args.expectedPairingRevision,
    signal: args.signal,
    supported: (route) =>
      sendRemoteRuntimeSharedControlRequestAbortable(
        route.environment.id,
        route.pairing,
        args.method,
        args.params,
        args.timeoutMs,
        args.envelope,
        args.signal
      ),
    unsupported: (route) =>
      sendRemoteRuntimeRequestAbortable(
        route.pairing,
        args.method,
        args.params,
        args.timeoutMs,
        args.envelope,
        args.signal,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      ),
    markUsed: (environmentId, response) => {
      if (response.ok) {
        markEnvironmentUsed(args.userDataPath, environmentId, {
          runtimeId: response._meta.runtimeId
        })
      }
    }
  })
}

export async function subscribeSupportRoutedRuntimeEnvironment(args: {
  userDataPath: string
  environment: KnownRuntimeEnvironment
  method: string
  params: unknown
  timeoutMs: number
  callbacks: SubscriptionCallbacks
  isCurrent: () => boolean
}): Promise<RemoteRuntimeSubscription> {
  let markedUsed = false
  let supportOutcome: SupportRoute['outcome'] | null = null
  const callbacks = subscriptionCallbacks(args, () => {
    if (
      markedUsed ||
      !args.isCurrent() ||
      (supportOutcome && !isRuntimeEnvironmentCapabilityOutcomeCurrent(supportOutcome))
    ) {
      return false
    }
    markedUsed = true
    return true
  })
  const routed = await routeRuntimeEnvironmentSubscriptionBySupport({
    userDataPath: args.userDataPath,
    environment: args.environment,
    timeoutMs: args.timeoutMs,
    isCurrent: args.isCurrent,
    supported: (route) => {
      supportOutcome = route.outcome
      return subscribeRemoteRuntimeSharedControlRequest(
        args.environment.id,
        route.pairing,
        args.method,
        args.params,
        args.timeoutMs,
        callbacks
      )
    },
    unsupported: (route) => {
      supportOutcome = route.outcome
      return subscribeRemoteRuntimeRequest(
        route.pairing,
        args.method,
        args.params,
        args.timeoutMs,
        callbacks,
        { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES }
      )
    }
  })
  return routed.subscription
}

export async function routeRuntimeEnvironmentCallBySupport(args: {
  userDataPath: string
  initialEnvironment: KnownRuntimeEnvironment
  method: string
  timeoutMs: number
  expectedPairingRevision?: number
  signal?: AbortSignal
  supported: (route: SupportRoute) => Promise<RuntimeRpcResponse<unknown>>
  unsupported: (route: SupportRoute) => Promise<RuntimeRpcResponse<unknown>>
  markUsed: (environmentId: string, response: RuntimeRpcResponse<unknown>) => void
}): Promise<RuntimeRpcResponse<unknown>> {
  let environment = args.initialEnvironment
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revisionFailure = runtimeEnvironmentRevisionFailure(
      environment,
      args.expectedPairingRevision,
      args.method
    )
    if (revisionFailure) {
      return revisionFailure
    }
    const pairing = getPreferredPairingOffer(environment)
    const outcome = await waitForPromiseWithSignal(
      supportsSharedControl(args.userDataPath, environment, pairing, args.timeoutMs),
      args.signal
    )
    if (
      outcome.kind !== 'stale_incarnation' &&
      isRuntimeEnvironmentCapabilityOutcomeCurrent(outcome)
    ) {
      const route = { environment, pairing, outcome }
      const response = await (outcome.kind === 'supported'
        ? args.supported(route)
        : args.unsupported(route))
      if (isRuntimeEnvironmentCapabilityOutcomeCurrent(outcome)) {
        args.markUsed(environment.id, response)
      }
      return response
    }
    clearSharedControlSupport(environment.id)
    environment = resolveEnvironment(args.userDataPath, environment.id)
  }
  return runtimeEnvironmentChangedFailure(environment, args.method)
}

export async function routeRuntimeEnvironmentSubscriptionBySupport<TSubscription>(args: {
  userDataPath: string
  environment: KnownRuntimeEnvironment
  timeoutMs: number
  isCurrent: () => boolean
  supported: (route: SupportRoute) => Promise<TSubscription>
  unsupported: (route: SupportRoute) => Promise<TSubscription>
}): Promise<{ subscription: TSubscription; outcome: SupportRoute['outcome'] }> {
  const pairing = getPreferredPairingOffer(args.environment)
  const outcome = await supportsSharedControl(
    args.userDataPath,
    args.environment,
    pairing,
    args.timeoutMs
  )
  if (
    outcome.kind === 'stale_incarnation' ||
    !args.isCurrent() ||
    !isRuntimeEnvironmentCapabilityOutcomeCurrent(outcome)
  ) {
    throw new Error('Runtime environment pairing changed; refresh and try again')
  }
  const route = { environment: args.environment, pairing, outcome }
  const subscription = await (outcome.kind === 'supported'
    ? args.supported(route)
    : args.unsupported(route))
  return { subscription, outcome }
}

function runtimeEnvironmentChangedFailure(
  environment: KnownRuntimeEnvironment,
  method: string
): RuntimeRpcResponse<never> {
  return {
    id: method,
    ok: false,
    error: {
      code: 'runtime_environment_changed',
      message: 'Runtime environment pairing changed; refresh and try again'
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}

function subscriptionCallbacks(
  args: Pick<
    Parameters<typeof subscribeSupportRoutedRuntimeEnvironment>[0],
    'userDataPath' | 'environment' | 'callbacks'
  >,
  shouldMarkUsed: () => boolean
) {
  const pairing = getPreferredPairingOffer(args.environment)
  return {
    onResponse: (response: RuntimeRpcResponse<unknown>) => {
      if (response.ok && shouldMarkUsed()) {
        markEnvironmentUsed(args.userDataPath, args.environment.id, {
          runtimeId: response._meta.runtimeId
        })
      }
      args.callbacks.onEvent({ type: 'response' as const, response })
    },
    onBinary: (bytes: Uint8Array<ArrayBufferLike>) =>
      args.callbacks.onEvent({ type: 'binary' as const, bytes }),
    onError: (error: { code: string; message: string }) =>
      args.callbacks.onEvent({
        type: 'error' as const,
        code: error.code,
        message: withRemoteRuntimeTailscaleHint(error.message, pairing.endpoint)
      }),
    onClose: () => {
      args.callbacks.onEvent({ type: 'close' as const })
      args.callbacks.onClose()
    }
  }
}
