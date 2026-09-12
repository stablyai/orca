import type { Store } from '../persistence'
import { activeSessions } from '../ipc/ssh-active-relay-sessions'
import { serializeOrcadMigrationValue } from '../../shared/orcad-migration-manifest'
import type { OrcadOutgoingCapture } from './orcad-outgoing-capture-store'
import type { OrcadSuccessorRetirementSession } from './orcad-successor-retirement-client'
import { resumeOrcadSavedSshSource } from './orcad-saved-source-resume'
import { getSshConnectionManager } from './ssh-target-registry'
import { fingerprintRuntimeSshTarget } from './runtime-ssh-access'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  hasSshTestConnectionProbes,
  pendingTransportReconnects,
  resetRelayInFlight,
  testingTargets
} from '../ipc/ssh-connect-attempt-registry'
import { assertSshResetAdmissionAllowed } from '../ipc/ssh-reset-production-state'
import { getSshProviderAuthority, isCurrentSshProviderAuthority } from './ssh-provider-authority'

/** Caller retains historical-holder exclusion and the complete missing-capture cohort. */
export async function retainOrcadLiveSuccessorSession(options: {
  targetId: string
  store: Pick<Store, 'getSshTarget' | 'getSshPtyConsumerRecovery' | 'upsertSshPtyConsumerRecovery'>
  captures: OrcadOutgoingCapture[]
  signal: AbortSignal
  assertAuthority: () => void
}): Promise<{
  readSession: () => OrcadSuccessorRetirementSession | null
  assertCurrent: () => void
  dispose: () => void | Promise<void>
}> {
  const { targetId, signal, assertAuthority, store } = options
  signal.throwIfAborted()
  assertAuthority()
  const first = options.captures[0]
  if (
    !first ||
    options.captures.some(
      (capture) =>
        capture.sourceSshTargetId !== targetId ||
        capture.identity.ownerLease !== first.identity.ownerLease ||
        capture.source.endpoint !== first.source.endpoint ||
        capture.source.incumbentVersion !== first.source.incumbentVersion ||
        capture.source.endpointCredential !== first.source.endpointCredential
    )
  ) {
    throw new Error('orcad_live_successor_source_cohort_mismatch')
  }
  const ownerLease = first.identity.ownerLease
  const source = {
    endpoint: first.source.endpoint,
    incumbentVersion: first.source.incumbentVersion,
    endpointCredential: first.source.endpointCredential
  }
  const existing = activeSessions.get(targetId)
  const providerAuthority = { ...getSshProviderAuthority(targetId) }
  let disposed = false
  const assertRetained = () => {
    signal.throwIfAborted()
    assertAuthority()
    assertSshConnectsNotFenced()
    assertSshResetAdmissionAllowed(targetId)
    if (
      !isCurrentSshProviderAuthority(providerAuthority) ||
      connectInFlight.has(targetId) ||
      pendingTransportReconnects.has(targetId) ||
      resetRelayInFlight.has(targetId) ||
      testingTargets.has(targetId) ||
      hasSshTestConnectionProbes(targetId)
    ) {
      throw new Error('orcad_live_successor_connection_activity_changed')
    }
    if (disposed) {
      throw new Error('orcad_live_successor_session_disposed')
    }
  }
  if (existing) {
    const admitted = existing.readSuccessorRetirementSession()
    if (!admitted?.resumed || admitted.owner.mode !== 'negotiated') {
      throw new Error('orcad_live_successor_session_required')
    }
    const { mux, connection, transportGeneration } = admitted
    const owner = serializeOrcadMigrationValue(admitted?.owner)
    const readSession = () =>
      activeSessions.get(targetId) === existing ? existing.readSuccessorRetirementSession() : null
    const assertCurrent = () => {
      assertRetained()
      const current = readSession()
      if (
        !admitted ||
        !current?.resumed ||
        current.targetId !== targetId ||
        current.owner.mode !== 'negotiated' ||
        current.owner.ownerLease !== ownerLease ||
        current.mux !== mux ||
        current.mux.isDisposed() ||
        current.connection !== connection ||
        current.transportGeneration !== transportGeneration ||
        !Number.isSafeInteger(current.transportGeneration) ||
        current.transportGeneration < 0 ||
        serializeOrcadMigrationValue(current.owner) !== owner
      ) {
        throw new Error('orcad_live_successor_session_changed')
      }
    }
    assertCurrent()
    return {
      readSession: () => {
        assertCurrent()
        return readSession()
      },
      assertCurrent,
      dispose: () => {
        disposed = true
      }
    }
  }
  const manager = getSshConnectionManager()
  let connection = manager?.getConnection(targetId)
  const target = store.getSshTarget(targetId)
  if (
    !target ||
    target.id !== targetId ||
    target.generation !== first.sourceSshTargetGeneration ||
    !Number.isSafeInteger(target.generation) ||
    target.generation! <= 0
  ) {
    throw new Error('orcad_live_successor_target_changed')
  }
  const fingerprint = fingerprintRuntimeSshTarget(target)
  const targetGeneration = target.generation
  const owner = serializeOrcadMigrationValue(target.owner)
  const assertTarget = (requireConnection = true) => {
    const current = store.getSshTarget(targetId)
    const connected = connection?.getTarget()
    if (
      [current, ...(requireConnection ? [connected] : [])].some(
        (candidate) =>
          !candidate ||
          candidate.id !== targetId ||
          candidate.generation !== targetGeneration ||
          candidate.orcadProvisioning ||
          fingerprintRuntimeSshTarget(candidate) !== fingerprint ||
          serializeOrcadMigrationValue(candidate.owner) !== owner
      )
    ) {
      throw new Error('orcad_live_successor_target_changed')
    }
  }
  let exclusive: Awaited<ReturnType<NonNullable<typeof manager>['connectExclusive']>> | undefined
  if (!connection) {
    const assertFresh = () => {
      assertRetained()
      assertTarget(false)
      if (!manager || getSshConnectionManager() !== manager || activeSessions.has(targetId)) {
        throw new Error('orcad_live_successor_connection_changed')
      }
    }
    assertFresh()
    exclusive = await manager!.connectExclusive(structuredClone(target), {
      signal,
      assertAuthority: assertFresh
    })
    connection = exclusive.connection
  }
  const assertConnection = () => {
    assertRetained()
    assertTarget()
    if (
      !manager ||
      !connection ||
      getSshConnectionManager() !== manager ||
      manager.getConnection(targetId) !== connection ||
      connection.getState().status !== 'connected' ||
      activeSessions.has(targetId)
    ) {
      throw new Error('orcad_live_successor_connection_changed')
    }
  }
  let owned: Awaited<ReturnType<typeof resumeOrcadSavedSshSource>> | undefined
  let disposal: Promise<void> | undefined
  const disposeOwned = (): Promise<void> => {
    disposed = true
    disposal ??= (async () => {
      const errors: unknown[] = []
      try {
        owned?.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        await exclusive?.release()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length === 1) {
        throw errors[0]
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'orcad_live_successor_owned_cleanup_failed')
      }
    })()
    return disposal
  }
  try {
    assertConnection()
    owned = await resumeOrcadSavedSshSource({
      targetId,
      store,
      connection: connection!,
      source,
      ownerLease,
      signal,
      assertAuthority: assertConnection
    })
    assertConnection()
    owned.assertCurrent()
    const admitted = owned
    return {
      readSession: () => {
        assertConnection()
        admitted.assertCurrent()
        return admitted.session
      },
      assertCurrent: () => {
        assertConnection()
        admitted.assertCurrent()
      },
      dispose: disposeOwned
    }
  } catch (error) {
    try {
      await disposeOwned()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'orcad_live_successor_connection_cleanup_failed'
      )
    }
    throw error
  }
}
