import { randomUUID } from 'node:crypto'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { isAbortSignalReason, throwIfSignalAborted } from '../../../../shared/abort-signal-reason'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import {
  RuntimeEnvironmentSetupGuardError,
  runtimeEnvironmentSetupFailure,
  type CrewSubscriptionSetupResult,
  type RuntimeEnvironmentSetupFailure
} from '../../../../shared/remote-runtime/host-catalog/runtime-environment-subscription-setup'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { RuntimeEnvironmentStoreError } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { isRuntimeEnvironmentManuallyDisconnected } from '../connectivity/runtime-environment-manual-disconnect'
import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { getAcceptedRuntimeEnvironmentCapabilityOutcome } from '../connections/runtime-environment-capability-evidence'
import { getRuntimeEnvironmentStatusSnapshot } from '../connections/runtime-environment-request-connections'

export type RuntimeEnvironmentSubscribeArgs = {
  selector: string
  method: string
  params?: unknown
  timeoutMs?: number
  subscriptionId?: string
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string | null
  setupResult?: 'crew'
}

export function assertCrewSubscriptionInputs(
  args: RuntimeEnvironmentSubscribeArgs,
  crewResult: boolean,
  subscriptionId: string,
  remoteRuntimeSubscriptions: ReadonlyMap<string, unknown>,
  pendingSubscriptions: ReadonlyMap<string, unknown>
): void {
  if (
    crewResult &&
    (args.method !== 'orchestration.crewSubscribe' ||
      typeof args.subscriptionId !== 'string' ||
      args.subscriptionId.length === 0 ||
      typeof args.expectedEnvironmentPairingRevision !== 'number' ||
      !Number.isFinite(args.expectedEnvironmentPairingRevision) ||
      !(
        args.expectedEnvironmentRuntimeId === null ||
        typeof args.expectedEnvironmentRuntimeId === 'string'
      ))
  ) {
    throw new RuntimeEnvironmentSetupGuardError('Invalid crew subscription setup inputs', {
      kind: 'input'
    })
  }
  if (remoteRuntimeSubscriptions.has(subscriptionId) || pendingSubscriptions.has(subscriptionId)) {
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment subscription id already exists',
      { kind: 'input' }
    )
  }
}

export async function resolveSubscriptionEnvironment(
  userDataPath: string,
  args: RuntimeEnvironmentSubscribeArgs
) {
  const environment = await resolveEnvironment(userDataPath, args.selector)
  if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
    throw new RuntimeEnvironmentSetupGuardError('runtime_manually_disconnected', {
      kind: 'manual-disconnect'
    })
  }
  const pairingRevision = environment.pairingRevision ?? environment.createdAt
  if (
    args.expectedEnvironmentPairingRevision !== undefined &&
    pairingRevision !== args.expectedEnvironmentPairingRevision
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment pairing changed; refresh and try again',
      { kind: 'source-retired' }
    )
  }
  if (
    args.expectedEnvironmentRuntimeId !== undefined &&
    environment.runtimeId !== args.expectedEnvironmentRuntimeId
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment identity changed; refresh and try again',
      { kind: 'source-retired' }
    )
  }
  return { environment, pairingRevision }
}

export async function assertCrewSubscriptionCurrent(
  event: IpcMainInvokeEvent,
  sender: WebContents,
  getUserDataPath: () => string,
  environment: Awaited<ReturnType<typeof resolveEnvironment>>,
  pairingRevision: number,
  args: RuntimeEnvironmentSubscribeArgs,
  transportIsCurrent: () => boolean,
  signal: AbortSignal,
  observeFailure: (failure: RuntimeEnvironmentSetupFailure) => void
): Promise<void> {
  throwIfSignalAborted(signal)
  if (
    sender.isDestroyed() ||
    !event.senderFrame ||
    event.senderFrame.detached ||
    event.senderFrame !== sender.mainFrame
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'The window that started this subscription went away',
      { kind: 'source-retired' }
    )
  }
  if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
    throw new RuntimeEnvironmentSetupGuardError('runtime_manually_disconnected', {
      kind: 'manual-disconnect'
    })
  }
  let current: Awaited<ReturnType<typeof resolveEnvironment>>
  try {
    current = await resolveEnvironment(getUserDataPath(), environment.id)
  } catch (error) {
    observeFailure(runtimeEnvironmentSetupFailure(error, 'environment-resolution'))
    throw error
  }
  throwIfSignalAborted(signal)
  if (
    sender.isDestroyed() ||
    !event.senderFrame ||
    event.senderFrame.detached ||
    event.senderFrame !== sender.mainFrame
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'The window that started this subscription went away',
      { kind: 'source-retired' }
    )
  }
  if (isRuntimeEnvironmentManuallyDisconnected(environment.id)) {
    throw new RuntimeEnvironmentSetupGuardError('runtime_manually_disconnected', {
      kind: 'manual-disconnect'
    })
  }
  if (
    !transportIsCurrent() ||
    (current.pairingRevision ?? current.createdAt) !== pairingRevision ||
    (args.expectedEnvironmentRuntimeId !== undefined &&
      current.runtimeId !== args.expectedEnvironmentRuntimeId)
  ) {
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment pairing changed; refresh and try again',
      { kind: 'source-retired' }
    )
  }
}

export function crewSubscriptionSetupFailure(
  subscriptionId: string,
  error: unknown,
  failure: RuntimeEnvironmentSetupFailure | undefined,
  operation: 'environment-resolution' | 'subscription',
  setupSignal: AbortSignal | undefined
): CrewSubscriptionSetupResult {
  const observed =
    error instanceof RuntimeEnvironmentSetupGuardError
      ? { error, fact: error.setupFact }
      : failure !== undefined && failure.error === error
        ? failure
        : runtimeEnvironmentSetupFailure(error, operation)
  const fact = isAbortSignalReason(setupSignal, error)
    ? { kind: 'cancelled' as const }
    : error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument'
      ? { kind: 'input' as const }
      : error instanceof RemoteRuntimeClientError
        ? { kind: 'remote' as const, code: error.code }
        : observed.fact
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
  return {
    subscriptionId,
    ok: false,
    failure: {
      message: error instanceof Error ? error.message : String(error),
      ...(code === undefined ? {} : { code }),
      fact
    }
  }
}

export type RetainedRemoteRuntimeSubscription = RemoteRuntimeTransportSubscription & {
  setupController: AbortController
  environmentId: string
  ownerWebContentsId: number
  disposeRendererLifetime: () => void
  notifyClosed: () => void
}
export type PendingRuntimeSubscription = {
  ownerWebContentsId: number
  environmentId: string
  close: () => void
}

export async function assertSubscriptionPairingCurrent(
  getUserDataPath: () => string,
  environment: Awaited<ReturnType<typeof resolveEnvironment>>,
  pairingRevision: number,
  transportIsCurrent: () => boolean,
  crewResult: boolean,
  disposeRendererLifetime: () => void,
  subscription: RemoteRuntimeTransportSubscription,
  observeFailure: (failure: RuntimeEnvironmentSetupFailure) => void
): Promise<void> {
  let pairingIsCurrent = false
  try {
    const currentEnvironment = await resolveEnvironment(getUserDataPath(), environment.id)
    pairingIsCurrent =
      (currentEnvironment.pairingRevision ?? currentEnvironment.createdAt) === pairingRevision
  } catch (error) {
    if (crewResult) {
      disposeRendererLifetime()
      subscription.close()
      observeFailure(runtimeEnvironmentSetupFailure(error, 'environment-resolution'))
      throw error
    }
    pairingIsCurrent = false
  }
  if (!transportIsCurrent() || !pairingIsCurrent) {
    disposeRendererLifetime()
    subscription.close()
    throw new RuntimeEnvironmentSetupGuardError(
      'Runtime environment pairing changed; refresh and try again',
      { kind: 'source-retired' }
    )
  }
}

export type RuntimeEnvironmentSubscriptionHandlerDependencies = {
  getUserDataPath: () => string
  remoteRuntimeSubscriptions: Map<string, RetainedRemoteRuntimeSubscription>
  pendingSubscriptions: Map<string, PendingRuntimeSubscription>
  createAssociationObserver?: (
    environmentId: string,
    identity: string
  ) => { observe: (frame: unknown) => void; dispose: () => void }
  recordLayoutFrame: (
    environmentId: string,
    method: string,
    response: RuntimeRpcResponse<unknown>
  ) => void
}

export function runtimeEnvironmentSubscriptionId(args: RuntimeEnvironmentSubscribeArgs): string {
  return typeof args.subscriptionId === 'string' && args.subscriptionId.length > 0
    ? args.subscriptionId
    : randomUUID()
}

export async function assertSettledCrewSubscriptionCurrent(
  crewResult: boolean,
  assertCrewCurrent: () => Promise<void>,
  disposeRendererLifetime: () => void,
  subscription: RemoteRuntimeTransportSubscription
): Promise<void> {
  if (crewResult) {
    try {
      await assertCrewCurrent()
    } catch (error) {
      disposeRendererLifetime()
      subscription.close()
      throw error
    }
  }
}

export function assertCrewSourceCurrent(
  environment: Awaited<ReturnType<typeof resolveEnvironment>>
): void {
  const connection = getPreferredPairedRuntimeConnection(environment)
  const accepted = getAcceptedRuntimeEnvironmentCapabilityOutcome(
    environment.id,
    connection,
    environment.runtimeId
  )
  if (accepted?.kind === 'unsupported') {
    throw new RuntimeEnvironmentSetupGuardError('Shared control is unavailable on this server', {
      kind: 'host-unsupported'
    })
  }
  const snapshot = getRuntimeEnvironmentStatusSnapshot(environment.id)
  if (
    accepted?.kind !== 'supported' ||
    environment.runtimeId === null ||
    !snapshot ||
    snapshot.retired ||
    snapshot.verification !== 'verified' ||
    snapshot.transport !== 'ready' ||
    snapshot.pairingRevision !== (environment.pairingRevision ?? environment.createdAt) ||
    snapshot.status?.runtimeId !== environment.runtimeId
  ) {
    throw new RuntimeEnvironmentSetupGuardError('The verified runtime session is unavailable', {
      kind: 'source-retired'
    })
  }
}
