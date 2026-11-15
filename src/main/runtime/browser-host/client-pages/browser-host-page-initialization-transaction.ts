import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type { BrowserHostPagePlacementRegistry } from '../reconciliation/browser-host-page-placement'
import type { BrowserClientPageExecutionHostGrant } from './browser-host-client-page-creation'
import type {
  Initialization,
  InitializationOutcome
} from './browser-host-page-initialization-records'
import { sameInitializationPlacement } from './browser-host-page-initialization-records'
import {
  awaitInitializationResult,
  closeInitializationGuest,
  issueInitializationCommand
} from './browser-host-page-initialization-commands'
import {
  clientPageCreationTimeout,
  waitForClientPageCreationResult
} from './browser-host-client-page-creation'
import { browserHostClientProfileFor } from '../profiles/browser-host-client-profile-metadata'

export type InitializationTransactionAuthority = {
  placements: BrowserHostPagePlacementRegistry
  grants: Map<string, BrowserClientPageExecutionHostGrant>
  retirePlacement(id: string, placement: RuntimeBrowserClientPlacement): void
  current(operation: Initialization): void
}

export async function runInitializationTransaction(
  operation: Initialization,
  authority: InitializationTransactionAuthority
): Promise<InitializationOutcome> {
  const { record, admission } = operation
  const { state, input, reservation } = admission
  let published = false
  try {
    authority.current(operation)
    if (operation.phase === 'cleanup') {
      operation.executionHostKey =
        (await awaitInitializationResult(
          input.resolveExecutionHostKey(),
          operation.controller.signal
        )) ?? undefined
      authority.current(operation)
      if (record.target) {
        try {
          await closeInitializationGuest(operation)
        } catch {
          return 'cleanup-unknown'
        }
      }
      authority.current(operation)
      return operation.executionHostKey === undefined ? 'route-parked' : 'prepared'
    }
    const executionHostKey = operation.executionHostKey
    if (!executionHostKey) {
      return 'route-parked'
    }
    operation.releaseGrant = state.executionHostGrants.retain(executionHostKey).release
    authority.current(operation)
    const previous = authority.placements.getPlacement(record.browserPageId)
    if (previous) {
      if (!sameInitializationPlacement(previous, input.expected)) {
        throw new Error('browser_page_placement_stale')
      }
      authority.retirePlacement(record.browserPageId, previous)
    }
    await waitForClientPageCreationResult(
      issueInitializationCommand(operation, () => authority.current(operation), {
        type: 'createPage',
        browserProfileId: input.browserProfileId,
        ...browserHostClientProfileFor(state.lease, input.browserProfileId),
        executionHostKey,
        workspaceId: input.workspaceId,
        initialUrl: input.url
      }),
      clientPageCreationTimeout(input.creationTimeoutMs)
    )
    authority.current(operation)
    const result = await issueInitializationCommand(operation, () => authority.current(operation), {
      type: 'navigate',
      url: input.url
    })
    authority.current(operation)
    if (typeof result.value !== 'string' || !reservation) {
      throw new Error('browser_client_page_initialization_result_invalid')
    }
    const placement = authority.placements.commitClientPageReservation(reservation)
    const grant = { placement, executionHostKey, release: operation.releaseGrant }
    authority.grants.set(record.browserPageId, grant)
    try {
      record.expected = placement
      operation.phase = 'published'
      input.publish(placement, result.value, executionHostKey)
      if (
        record.closed ||
        operation.detached ||
        operation.controller.signal.aborted ||
        admission.connectionToken !== state.connectionToken
      ) {
        throw new Error('browser_client_page_initialization_stale')
      }
      published = true
      input.completed?.(result.value)
      operation.releaseGrant = undefined
      record.target = undefined
    } catch (error) {
      if (authority.grants.get(record.browserPageId) === grant) {
        authority.grants.delete(record.browserPageId)
      }
      const current = authority.placements.getPlacement(record.browserPageId)
      if (current === placement) {
        authority.placements.completePageRetirement(
          authority.placements.beginPageRetirement(record.browserPageId, placement)
        )
      }
      throw error
    }
    return 'published'
  } catch {
    if (!operation.detached) {
      try {
        await closeInitializationGuest(operation)
      } catch {
        return 'cleanup-unknown'
      }
    }
    return record.closed ? 'disposed' : 'retained-clean'
  } finally {
    if (!published && operation.phase !== 'cleanup') {
      if (reservation) {
        authority.placements.cancelClientPageReservation(reservation)
      }
      if (!record.target || operation.detached) {
        operation.releaseGrant?.()
        operation.releaseGrant = undefined
      }
    }
  }
}
