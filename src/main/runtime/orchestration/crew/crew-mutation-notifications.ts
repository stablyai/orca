import type { OrchestrationDb } from '../db'

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
  'importFederatedRelayItem',
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
  'updateFederatedDispatchResources',
  'updateFederatedDispatchRuntimeEpoch',
  'transitionLifecycle',
  'abandonWorkerDispatch',
  'failWorkerStart',
  'markWorkerStartUnknown',
  'beginWorkerStop',
  'settleWorkerStop',
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
      this.crewChanges.notify(
        new Set([result.delivery_contract === 'legacy_direct' ? 'topology' : 'traffic'])
      )
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
        const result = original.apply(this, args)
        if (
          typeof result === 'object' &&
          result !== null &&
          'types' in result &&
          Array.isArray(result.types) &&
          result.types.every((type) => type === 'heartbeat')
        ) {
          return result
        }
        this.crewChanges.notify(new Set([trafficMutations.has(name) ? 'traffic' : 'topology']))
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
