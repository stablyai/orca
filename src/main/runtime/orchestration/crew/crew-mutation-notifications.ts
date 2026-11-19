import { scopedCrewChange, type CrewInvalidation } from './crew-changes'
import type { OrchestrationDb } from '../db/orchestration-db'
import {
  collectDispatchWrites,
  createdDispatchParties,
  dispatchMutations,
  dispatchOf,
  noticedMutations,
  progressMutations,
  runCoordinatorParties
} from './crew-mutation-scopes'

type CrewMutationPrototype = Partial<OrchestrationDb>
type CrewMutationInvocation = (this: OrchestrationDb, ...args: unknown[]) => unknown

const mutations = [
  'createRemoteDispatchAttachment',
  'prepareRemoteAttachmentAuthority',
  'markRemoteAttachmentReady',
  'recordRemoteAttachmentStage',
  'settleRemoteAttachmentInRelayTransaction',
  'updateRemoteAttachmentSetupEvidence',
  'failRemoteAttachment',
  'beginRemoteAttachmentStop',
  'settleRemoteAttachmentStop',
  'markRemoteAttachmentStopUnknown',
  'requestRemoteAttachmentTerminalRelease',
  'routeDirectMessagePage',
  'routeUnreadDispatchMailboxToRunMailbox',
  'routeForeignDirectMessagesToOwnedMailboxes',
  'registerFederatedQuestion',
  'answerRemoteQuestion',
  'convertLifecycleMessageToRejection',
  'createWorkerTerminalResourceStatement',
  'transferWorkerTerminalResourceStatement',
  'rekeyWorkerTerminalResourcePaneKey',
  'createDispatchContext',
  'createStartingWorkerDispatch',
  'prepareStartingWorkerAuthority',
  'markWorkerDispatchReady',
  'recordWorkerStage',
  'completeDispatch',
  'completeActiveDispatchesForTask',
  'failActiveDispatchForTask',
  'failDispatch',
  'settleWorkerReport',
  'settleWorkerReportInTransaction',
  'reconcileFederatedWorkerStart',
  'reconcileMissingWorkerTerminal',
  'promoteReadyTasks',
  'bindRun',
  'createRun',
  'createQuestion',
  'answerQuestion',
  'closeQuestionsForDispatch',
  'createGate',
  'resolveGate',
  'timeoutGate',
  'updateTaskStatus',
  'transitionLifecycle',
  'abandonWorkerDispatch',
  'failWorkerStart',
  'markWorkerStartUnknown',
  'beginWorkerStop',
  'settleWorkerStop',
  'settleDeadWorkerTerminalReleases',
  'markWorkerStopUnknown',
  'unbindOtherRunsForCoordinator',
  'recordAttemptObservation',
  'resetAll',
  'resetTasks',
  'resetMessages'
] as const satisfies readonly (keyof OrchestrationDb)[]

const trafficMutations: ReadonlySet<keyof OrchestrationDb> = new Set([
  'routeDirectMessagePage',
  'routeUnreadDispatchMailboxToRunMailbox',
  'routeForeignDirectMessagesToOwnedMailboxes',
  'registerFederatedQuestion',
  'answerRemoteQuestion',
  'convertLifecycleMessageToRejection',
  'createQuestion',
  'answerQuestion',
  'closeQuestionsForDispatch',
  'createGate',
  'resolveGate',
  'timeoutGate'
])

/** Wake after the synchronous outer mutation; nested writes coalesce and rolled-back reads compare equal. */
export function attachCrewMutationNotifications(ctor: { prototype: CrewMutationPrototype }): void {
  const prototype = ctor.prototype
  if (
    !hasDomainMethod(prototype, 'getOrCreateLocalMutationCallerFingerprint') ||
    !hasDomainMethod(prototype, 'insertMessage')
  ) {
    throw new Error('Crew notifications require installed orchestration methods')
  }
  if (hasDomainMethod(prototype, 'settleWorkerTerminalRelease')) {
    const release = prototype.settleWorkerTerminalRelease
    prototype.settleWorkerTerminalRelease = function (this: OrchestrationDb, resourceId) {
      const before = this.getWorkerTerminalResource(resourceId)?.release_state
      const result = release.call(this, resourceId)
      if (before !== result.release_state) {
        this.crewChanges.notify(new Set(['topology']))
      }
      return result
    }
  }
  if (hasDomainMethod(prototype, 'settleDeadWorkerTerminalRelease')) {
    const release = prototype.settleDeadWorkerTerminalRelease
    prototype.settleDeadWorkerTerminalRelease = function (this: OrchestrationDb, params) {
      const before = this.getWorkerTerminalResource(params.resourceId)?.release_state
      const result = release.call(this, params)
      if (before !== result.resource.release_state) {
        this.crewChanges.notify(new Set(['topology']))
      }
      return result
    }
  }
  if (hasDomainMethod(prototype, 'commitLegacyCompatibilityPrincipal')) {
    const commit = prototype.commitLegacyCompatibilityPrincipal
    prototype.commitLegacyCompatibilityPrincipal = function (this: OrchestrationDb, params) {
      const result = commit.call(this, params)
      if (!result.duplicate) {
        this.crewChanges.notify(new Set(['topology']))
      }
      return result
    }
  }
  const sourceIdentity = prototype.getOrCreateLocalMutationCallerFingerprint
  prototype.getOrCreateLocalMutationCallerFingerprint = function (this: OrchestrationDb) {
    const known = this.localMutationCallerFingerprint
    const result = sourceIdentity.call(this)
    if (!known) {
      this.crewChanges.notify()
    }
    return result
  }
  const insert = prototype.insertMessage
  prototype.insertMessage = function (this: OrchestrationDb, message) {
    const result = insert.call(this, message)
    if (result.type !== 'heartbeat') {
      const notice: CrewInvalidation =
        result.delivery_contract === 'legacy_direct'
          ? new Set(['topology'])
          : Object.assign(new Set(['traffic'] as const), {
              trafficAddresses: new Set([result.from_handle, result.to_handle])
            })
      this.crewChanges.notify(notice)
    }
    return result
  }
  for (const name of mutations) {
    if (!hasCrewMutationInvocation(prototype, name)) {
      continue
    }
    const original: CrewMutationInvocation = prototype[name]
    Object.defineProperty(ctor.prototype, name, {
      configurable: true,
      writable: true,
      value(this: OrchestrationDb, ...args: unknown[]) {
        const scoped =
          (progressMutations.has(name) || dispatchMutations.has(name)) && dispatchOf(args[0])
        const noticed = noticedMutations.has(name)
        const [result, written] =
          scoped || noticed
            ? collectDispatchWrites(this, () => original.apply(this, args), !noticed)
            : [original.apply(this, args), null]
        if (
          typeof result === 'object' &&
          result !== null &&
          'types' in result &&
          Array.isArray(result.types) &&
          result.types.every((type) => type === 'heartbeat')
        ) {
          return result
        }
        if (
          typeof result === 'object' &&
          result !== null &&
          'duplicate' in result &&
          result.duplicate === true &&
          name === 'recordAttemptObservation'
        ) {
          return result
        }
        const runParties = name === 'createRun' ? runCoordinatorParties(args[0]) : null
        if (scoped && written) {
          written.dispatchIds.add(scoped)
          this.crewChanges.notify(
            scopedCrewChange([progressMutations.has(name) ? 'assignments' : 'topology'], {
              dispatchIds: written.dispatchIds
            })
          )
        } else if (noticed && written) {
          // Nothing noticed: the call wrote no row a crew shows.
          if (written.dispatchIds.size > 0) {
            this.crewChanges.notify(
              scopedCrewChange(['topology'], {
                dispatchIds: written.dispatchIds,
                ...(written.created.size > 0
                  ? { parties: createdDispatchParties(this, written.created) }
                  : {})
              })
            )
          }
        } else if (runParties) {
          this.crewChanges.notify(scopedCrewChange(['topology'], { parties: runParties }))
        } else if (name === 'closeQuestionsForDispatch' && dispatchOf(args[0])) {
          // One Dispatch's questions and helper mail: the crews showing that Dispatch read them.
          this.crewChanges.notify(
            scopedCrewChange(['traffic'], { dispatchIds: new Set([dispatchOf(args[0])!]) })
          )
        } else {
          this.crewChanges.notify(new Set([trafficMutations.has(name) ? 'traffic' : 'topology']))
        }
        return result
      }
    })
  }
}

function hasDomainMethod<K extends keyof OrchestrationDb>(
  prototype: CrewMutationPrototype,
  name: K
): prototype is CrewMutationPrototype & Pick<OrchestrationDb, K> {
  return name in prototype && typeof prototype[name] === 'function'
}

function hasCrewMutationInvocation<K extends (typeof mutations)[number]>(
  prototype: CrewMutationPrototype,
  name: K
): prototype is CrewMutationPrototype & Record<K, CrewMutationInvocation> {
  return hasDomainMethod(prototype, name)
}
