import type { BrowserClientHostCommandResult } from '../../shared/browser-client-host-protocol'
import {
  DEFAULT_CLIENT_PAGE_CREATION_TIMEOUT_MS,
  MAX_CLIENT_PAGE_CREATION_TIMEOUT_MS
} from '../../shared/browser-client-page-creation-timeouts'
import { assertBrowserHostPageCommandAdmission } from './browser-host-page-command-admission'
import type { BrowserHostLease, BrowserHostLeaseState } from './browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'

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
    executionHostGrants: Map<string, BrowserClientPageExecutionHostGrant>
  }
): Promise<RuntimeBrowserClientPlacement> {
  const timeoutMs = clientPageCreationTimeout(options.timeoutMs)
  const lease = dependencies.selectLease(
    options.browserHostClientId,
    options.requiredCapabilities ?? []
  )
  if (lease.pairedDeviceId !== options.pairedDeviceId) {
    throw new Error('browser_host_lease_stale')
  }
  if (lease.pageCommandProtocolVersion !== 1 || lease.pageReconciliationProtocolVersion !== 1) {
    throw new Error('browser_host_reconciliation_protocol_required')
  }
  if (dependencies.executionHostGrants.has(options.browserPageId)) {
    throw new Error('browser_page_replacement_requires_retirement')
  }
  const state = dependencies.requireLeaseState(lease)
  const ledger = state.commandLedger
  if (!ledger) {
    throw new Error('browser_host_command_protocol_required')
  }
  const reservation = dependencies.pagePlacements.reserveNewClientPage(options.browserPageId, {
    browserHostClientId: lease.browserHostClientId,
    browserHostGeneration: lease.browserHostGeneration
  })
  const grant = state.executionHostGrants.retain(options.executionHostKey)
  let createIssued = false
  try {
    const command = {
      type: 'createPage' as const,
      browserProfileId: options.browserProfileId,
      executionHostKey: options.executionHostKey,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {})
    }
    assertBrowserHostPageCommandAdmission(lease, command, (executionHostKey) =>
      state.executionHostGrants.require(executionHostKey)
    )
    const issued = ledger.issue({
      browserPageId: options.browserPageId,
      pageHostGeneration: reservation.placement.pageHostGeneration,
      command,
      resultAdmission: 'reserved-page'
    })
    createIssued = true
    const result = await waitForClientPageCreationResult(issued.result, timeoutMs)
    if (result.status === 'failed') {
      throw new Error(result.errorCode)
    }
    dependencies.requireLeaseState(lease)
    const placement = dependencies.pagePlacements.commitClientPageReservation(reservation)
    dependencies.executionHostGrants.set(options.browserPageId, {
      placement,
      executionHostKey: options.executionHostKey,
      release: grant.release
    })
    return placement
  } catch (error) {
    try {
      dependencies.pagePlacements.cancelClientPageReservation(reservation)
      if (createIssued) {
        closeUncommittedClientPage(state, options.browserPageId, reservation.placement)
      } else {
        retireUncommittedClientPage(
          ledger,
          options.browserPageId,
          reservation.placement.pageHostGeneration
        )
      }
    } finally {
      grant.release()
    }
    throw error
  }
}

function clientPageCreationTimeout(timeoutMs: number | undefined): number {
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

async function waitForClientPageCreationResult(
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

function closeUncommittedClientPage(
  state: BrowserHostLeaseState,
  browserPageId: string,
  placement: RuntimeBrowserClientPlacement
): void {
  const ledger = state.commandLedger
  if (!ledger) {
    return
  }
  try {
    const close = ledger.issue({
      browserPageId,
      pageHostGeneration: placement.pageHostGeneration,
      command: {
        type: 'closePage',
        targetAuthority: {
          authorityRuntimeId: state.lease.authorityRuntimeId,
          authorityEpoch: state.lease.authorityEpoch,
          browserHostClientId: placement.browserHostClientId,
          browserHostGeneration: placement.browserHostGeneration,
          pageHostGeneration: placement.pageHostGeneration
        }
      },
      resultAdmission: 'reserved-page'
    })
    void close.result.then(
      () => retireUncommittedClientPage(ledger, browserPageId, placement.pageHostGeneration),
      () => retireUncommittedClientPage(ledger, browserPageId, placement.pageHostGeneration)
    )
  } catch {
    retireUncommittedClientPage(ledger, browserPageId, placement.pageHostGeneration)
  }
}

function retireUncommittedClientPage(
  ledger: NonNullable<BrowserHostLeaseState['commandLedger']>,
  browserPageId: string,
  pageHostGeneration: number
): void {
  try {
    ledger.retirePage(browserPageId, pageHostGeneration)
  } catch {
    // Best-effort close converges through authenticated inventory reconciliation.
  }
}
