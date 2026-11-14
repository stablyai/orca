import {
  closeUncommittedClientPage,
  retireUncommittedClientPage
} from './browser-host-uncommitted-client-page'
import type { BrowserHostLegacyPageRecoveryClaim } from './browser-host-page-legacy-recovery'
import type { BrowserHostPageInitializations } from './browser-host-page-initialization'
import { createBrowserHostClientPageRequest } from './browser-host-client-page-request'
import type {
  BrowserClientPagePlacementReservation,
  BrowserHostPagePlacementRegistry
} from '../reconciliation/browser-host-page-placement'
import { BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BROWSER_HOST_WEBVIEW_CAPABILITY } from '../leases/browser-host-capability-selection'
import { browserHostClientProfileFor } from '../profiles/browser-host-client-profile-metadata'
import type { BrowserClientAutomationResult as BrowserClientHostCommandResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import {
  DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS,
  MAX_CLIENT_PAGE_CREATION_TIMEOUT_MS
} from '../../../../shared/browser/client-hosting/browser-client-page-creation-timeouts'
import { assertBrowserHostPageCommandAdmission } from '../commands/browser-host-page-command-admission'
import type { BrowserHostLease, BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'

export type BrowserClientPageExecutionHostGrant = {
  placement: RuntimeBrowserClientPlacement
  executionHostKey: string
  release: () => void
}

export type BrowserHostClientPageCreateOptions = {
  browserPageId: string
  browserHostClientId: string
  pairedDeviceId: string
  browserProfileId: string
  executionHostKey: string
  requiredCapabilities?: readonly string[]
  timeoutMs?: number
  workspaceId?: string
  signal?: AbortSignal
  legacyRecovery?: BrowserHostLegacyPageRecoveryClaim
  committed?(placement: RuntimeBrowserClientPlacement): void
}

export async function createBrowserHostClientPage(
  options: BrowserHostClientPageCreateOptions,
  dependencies: {
    selectLease(
      browserHostClientId: string,
      requiredCapabilities: readonly string[]
    ): BrowserHostLease
    requireLeaseState(lease: BrowserHostLease): BrowserHostLeaseState
    pagePlacements: BrowserHostPagePlacementRegistry
    initializations: Pick<
      BrowserHostPageInitializations,
      'whenPrepared' | 'retireUnpublished' | 'assertCreationAdmission'
    >
    executionHostGrants: Map<string, BrowserClientPageExecutionHostGrant>
  }
): Promise<RuntimeBrowserClientPlacement> {
  const request = createBrowserHostClientPageRequest(
    clientPageCreationTimeout(options.timeoutMs),
    options.signal
  )
  let reservation: BrowserClientPagePlacementReservation | undefined
  let grant: { release(): void } | undefined
  let createIssued = false
  let placement: RuntimeBrowserClientPlacement | undefined
  let committedGrant: BrowserClientPageExecutionHostGrant | undefined
  let state: BrowserHostLeaseState | undefined
  let modern = false
  try {
    request.current()
    const lease = dependencies.selectLease(options.browserHostClientId, [
      BROWSER_HOST_WEBVIEW_CAPABILITY,
      ...(options.requiredCapabilities ?? [])
    ])
    if (lease.pairedDeviceId !== options.pairedDeviceId) {
      throw new Error('browser_host_lease_stale')
    }
    if (lease.pageCommandProtocolVersion !== 1 || lease.pageReconciliationProtocolVersion !== 1) {
      throw new Error('browser_host_reconciliation_protocol_required')
    }
    state = dependencies.requireLeaseState(lease)
    const currentState = state
    const ledger = state.commandLedger
    if (!ledger) {
      throw new Error('browser_host_command_protocol_required')
    }
    modern = lease.hostCapabilities.includes(BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY)
    let result: Promise<BrowserClientHostCommandResult> | undefined
    const admit = (): void => {
      request.current()
      if (
        dependencies.requireLeaseState(lease) !== currentState ||
        currentState.commandLedger !== ledger ||
        currentState.lease.pairedDeviceId !== options.pairedDeviceId
      ) {
        throw new Error('browser_host_lease_stale')
      }
      if (dependencies.executionHostGrants.has(options.browserPageId)) {
        throw new Error('browser_page_replacement_requires_retirement')
      }
      if (options.legacyRecovery) {
        options.legacyRecovery.admit(options.browserPageId, currentState, request.cancel)
      } else {
        dependencies.initializations.assertCreationAdmission(options.browserPageId)
      }
      dependencies.pagePlacements.assertPlacementAdmission(options.browserPageId)
      reservation = dependencies.pagePlacements.reserveNewClientPage(options.browserPageId, lease)
      grant = currentState.executionHostGrants.retain(options.executionHostKey)
      const command = {
        type: 'createPage' as const,
        ...(modern ? { initialUrl: 'about:blank' } : {}),
        browserProfileId: options.browserProfileId,
        ...browserHostClientProfileFor(currentState.lease, options.browserProfileId),
        executionHostKey: options.executionHostKey,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {})
      }
      assertBrowserHostPageCommandAdmission(currentState.lease, command, (key) =>
        currentState.executionHostGrants.require(key)
      )
      result = ledger.issue(
        {
          browserPageId: options.browserPageId,
          pageHostGeneration: reservation.placement.pageHostGeneration,
          command,
          resultAdmission: 'reserved-page'
        },
        () => {
          createIssued = true
        }
      ).result
    }
    if (modern) {
      await dependencies.initializations.whenPrepared(
        currentState,
        options.browserProfileId,
        options.executionHostKey,
        request.signal,
        admit
      )
    } else {
      admit()
    }
    const created = await request.wait(result!)
    request.current()
    if (created.status === 'failed') {
      throw new Error(created.errorCode)
    }
    if (modern) {
      const initialized = await request.wait(
        ledger.issue({
          browserPageId: options.browserPageId,
          pageHostGeneration: reservation!.placement.pageHostGeneration,
          command: { type: 'navigate', url: 'about:blank' },
          resultAdmission: 'reserved-page'
        }).result
      )
      if (initialized.status === 'failed') {
        throw new Error(initialized.errorCode)
      }
    }
    request.current()
    dependencies.requireLeaseState(lease)
    options.legacyRecovery?.validate(state)
    placement = dependencies.pagePlacements.commitClientPageReservation(reservation!)
    committedGrant = {
      placement,
      executionHostKey: options.executionHostKey,
      release: grant!.release
    }
    dependencies.executionHostGrants.set(options.browserPageId, committedGrant)
    if (options.legacyRecovery) {
      options.legacyRecovery.commit(state, placement, () => options.committed?.(placement!))
    } else {
      options.committed?.(placement)
    }
    return placement
  } catch (error) {
    if (reservation && state) {
      if (
        committedGrant &&
        dependencies.executionHostGrants.get(options.browserPageId) === committedGrant
      ) {
        dependencies.executionHostGrants.delete(options.browserPageId)
      }
      if (createIssued && options.legacyRecovery) {
        if (
          options.legacyRecovery.failed(
            reservation.placement,
            options.executionHostKey,
            grant!.release
          )
        ) {
          grant = undefined
        }
      } else if (createIssued && modern) {
        // Exact cleanup takes the slot and grant before the request gives up its reservation.
        dependencies.initializations.retireUnpublished(
          state,
          {
            browserPageId: options.browserPageId,
            browserProfileId: options.browserProfileId,
            workspaceId: options.workspaceId ?? '',
            expected: reservation.placement,
            url: 'about:blank',
            isCurrent: () => false,
            resolveExecutionHostKey: async () => null,
            publish: () => {}
          },
          { executionHostKey: options.executionHostKey, releaseGrant: grant!.release }
        )
        grant = undefined
      } else if (createIssued) {
        closeUncommittedClientPage(state, options.browserPageId, reservation.placement)
      } else if (state.commandLedger) {
        retireUncommittedClientPage(
          state.commandLedger,
          options.browserPageId,
          reservation.placement.pageHostGeneration
        )
      }
      if (
        placement &&
        dependencies.pagePlacements.getPlacement(options.browserPageId) === placement
      ) {
        dependencies.pagePlacements.completePageRetirement(
          dependencies.pagePlacements.beginPageRetirement(options.browserPageId, placement)
        )
      }
      dependencies.pagePlacements.cancelClientPageReservation(reservation)
    }
    grant?.release()
    throw error
  } finally {
    request.dispose()
    options.legacyRecovery?.finish()
  }
}

export function clientPageCreationTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS
  if (
    !Number.isInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_CLIENT_PAGE_CREATION_TIMEOUT_MS
  ) {
    throw new Error('browser_host_page_creation_timeout_invalid')
  }
  return resolved
}

export async function waitForClientPageCreationResult(
  result: Promise<BrowserClientHostCommandResult>,
  timeoutMs: number
): Promise<BrowserClientHostCommandResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('browser_host_page_creation_timeout')),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
