import type { SshConnectionManager } from '../ssh/ssh-connection-manager'
import type { SshPortForwardManager } from '../ssh/ssh-port-forward'
import type { SshRelaySession } from '../ssh/ssh-relay-session'
import { activeSessions } from './ssh-active-relay-sessions'
import { captureSshBrowserResetRetirement } from '../browser/ssh-browser-route-lifetimes'
import { parseSshRelayResetIntent, type SshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import {
  parseRelayOwnerResetAcknowledgment,
  type RelayOwnerResetAcknowledgment
} from '../../shared/relay-owner-reset-contract'

/** Caller fences admission and retains this handle through uncertain reset/cleanup outcomes. */
export function captureSshResetTransportRetirement(options: {
  targetId: string
  session: SshRelaySession
  connections: Pick<SshConnectionManager, 'getConnection' | 'disconnectConnection'>
  forwards: Pick<SshPortForwardManager, 'captureForwardCleanup' | 'fenceForwardAdmission'>
  intent?: SshRelayResetIntent
  /** Must retain exact operation authority after acknowledged transport retirement. */
  assertAuthority: () => void
  removeCapturedSession?: (assertLocalRetired: () => void) => void
}) {
  const { targetId, session, connections, forwards, assertAuthority } = options
  const intent = options.intent ? parseSshRelayResetIntent(options.intent) : undefined
  if (intent && intent.targetId !== targetId) {
    throw new Error('ssh_reset_intent_target_mismatch')
  }
  let preparationConfirmed = false
  assertAuthority()
  if (activeSessions.get(targetId) !== session) {
    throw new Error('ssh_reset_session_changed')
  }
  const captured = session.captureResetRetirement()
  const controlChannel = captured.mux.getSourceChannel()
  if (!controlChannel) {
    throw new Error('ssh_reset_control_channel_unproven')
  }
  let directWork: ReturnType<typeof captured.connection.fenceWorkForReset> | undefined
  let forwardAdmission: ReturnType<SshPortForwardManager['fenceForwardAdmission']> | undefined
  let forwardCleanup: ReturnType<SshPortForwardManager['captureForwardCleanup']> | undefined
  let forwardRelease: { assertReleased: () => void } | undefined
  let disconnectStarted = false
  let disconnected = false
  let sessionRemoved = false
  let browserRetirement: ReturnType<typeof captureSshBrowserResetRetirement> | undefined
  const assertBindings = () => {
    assertAuthority()
    if (captured.mux.getSourceChannel() !== controlChannel) {
      throw new Error('ssh_reset_control_channel_changed')
    }
    if (activeSessions.get(targetId) !== (sessionRemoved ? undefined : session)) {
      throw new Error('ssh_reset_session_changed')
    }
    const connection = connections.getConnection(targetId)
    if (connection !== captured.connection && !(disconnectStarted && connection === undefined)) {
      throw new Error('ssh_reset_connection_changed')
    }
  }
  assertBindings()
  captured.assertCurrent()
  const assertDrainedForAcknowledgment = () => {
    assertBindings()
    captured.assertCurrent()
    if (!forwardCleanup || !forwardAdmission || !directWork) {
      throw new Error('ssh_reset_publication_not_drained')
    }
    forwardAdmission.assertDrained()
    if (intent) {
      forwardAdmission.assertResetRetirementSupported()
    }
    directWork.assertDrained()
    captured.assertNetworkTunnelsDrained()
    captured.mux.assertRelayResetAcknowledgmentDrained(intent?.request)
    browserRetirement?.assertCurrent()
  }
  return {
    ...captured,
    begin: () => {
      assertBindings()
      captured.assertCurrent()
      directWork ??= captured.connection.fenceWorkForReset(controlChannel)
      forwardAdmission ??= forwards.fenceForwardAdmission(targetId)
      forwardAdmission.assertClosed()
      captured.begin()
    },
    drain: async (signal: AbortSignal) => {
      assertBindings()
      captured.assertCurrent()
      if (!forwardAdmission || !directWork) {
        throw new Error('ssh_reset_admission_not_closed')
      }
      signal.throwIfAborted()
      const observer = new AbortController()
      try {
        const combined = AbortSignal.any([signal, observer.signal])
        await Promise.all([
          directWork.drain(combined),
          forwardAdmission.drain(combined),
          captured.drainNetworkTunnels(combined),
          captured.mux.waitForRelayResetDrain(combined)
        ])
        signal.throwIfAborted()
      } finally {
        observer.abort()
      }
      assertBindings()
      captured.assertCurrent()
      forwardAdmission.assertDrained()
      directWork.assertDrained()
      if (intent) {
        forwardAdmission.assertResetRetirementSupported()
      }
      forwardCleanup ??= forwards.captureForwardCleanup(targetId)
      if (intent) {
        browserRetirement ??= captureSshBrowserResetRetirement({
          targetId,
          connection: captured.connection,
          request: intent.request,
          assertAuthority
        })
      }
    },
    assertDrainedForAcknowledgment,
    releaseForwardAdmission: (assertLocalRetired: () => void): undefined => {
      if (!sessionRemoved || !disconnected || !forwardAdmission || !forwardCleanup || !directWork) {
        throw new Error('ssh_reset_transport_retirement_unconfirmed')
      }
      const assertRetired = () => {
        assertBindings()
        captured.assertRetired()
        forwardCleanup!.assertRemoved()
        directWork!.assertDrained()
        assertLocalRetired()
      }
      assertRetired()
      browserRetirement?.assertReconciled()
      forwardRelease ??= forwardAdmission.release(assertRetired)
      forwardRelease.assertReleased()
    },
    onPreparedAcknowledgment: (
      acknowledgment: Readonly<RelayOwnerResetAcknowledgment>,
      acknowledgedIntent: SshRelayResetIntent
    ): undefined => {
      if (
        !intent ||
        JSON.stringify(parseSshRelayResetIntent(acknowledgedIntent)) !== JSON.stringify(intent)
      ) {
        throw new Error('ssh_reset_acknowledgment_intent_mismatch')
      }
      parseRelayOwnerResetAcknowledgment(acknowledgment, intent.request)
      if (preparationConfirmed) {
        throw new Error('ssh_reset_acknowledgment_repeated')
      }
      assertDrainedForAcknowledgment()
      captured.confirmNetworkResetRetirement(intent.request)
      preparationConfirmed = true
    },
    teardown: async (assertLocalRetired: () => void) => {
      if (intent && !preparationConfirmed) {
        throw new Error('ssh_reset_preparation_unconfirmed')
      }
      const cleanup = forwardCleanup
      const admission = forwardAdmission
      const work = directWork
      if (!cleanup || !admission || !work) {
        throw new Error('ssh_reset_publication_not_drained')
      }
      const assertAuthorityAndLocal = () => {
        assertBindings()
        browserRetirement?.assertCurrent()
        if (forwardRelease) {
          forwardRelease.assertReleased()
        } else {
          admission.assertDrained()
        }
        work.assertDrained()
        assertLocalRetired()
      }
      assertAuthorityAndLocal()
      captured.retire(assertAuthorityAndLocal)
      captured.assertRetired()
      await cleanup.removeAndWait()
      assertAuthorityAndLocal()
      if (intent) {
        admission.reconcileResetRetirement(intent.request)
      }
      captured.assertRetired()
      cleanup.assertRemoved()
      if (!disconnected) {
        disconnectStarted = true
        await connections.disconnectConnection(targetId, captured.connection)
        assertAuthorityAndLocal()
        captured.assertRetired()
        cleanup.assertRemoved()
        if (captured.connection.getState().status !== 'disconnected') {
          throw new Error('ssh_reset_disconnect_unconfirmed')
        }
        disconnected = true
      }
      assertAuthorityAndLocal()
      if (!sessionRemoved) {
        if (options.removeCapturedSession) {
          options.removeCapturedSession(assertLocalRetired)
        } else {
          activeSessions.delete(targetId)
        }
        sessionRemoved = true
      }
      const assertRetired = () => {
        assertAuthorityAndLocal()
        captured.assertRetired()
        cleanup.assertRemoved()
        if (
          !sessionRemoved ||
          !disconnected ||
          connections.getConnection(targetId) !== undefined ||
          captured.connection.getState().status !== 'disconnected'
        ) {
          throw new Error('ssh_reset_transport_retirement_unconfirmed')
        }
      }
      assertRetired()
      browserRetirement?.reconcile(assertRetired)
      return {
        assertRetired: () => {
          assertRetired()
          browserRetirement?.assertReconciled()
        }
      }
    }
  }
}
