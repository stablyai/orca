import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from '../reconciliation/browser-host-page-placement'
import {
  sameInitializationPlacement,
  type InitializationRecord
} from './browser-host-page-initialization-records'

export type BrowserHostLegacyPageRecoveryInput = {
  browserPageId: string
  browserProfileId: string
  workspaceId: string
  expected: RuntimeBrowserClientPlacement
  isCurrent(): boolean
}

export type BrowserHostLegacyPageRecoveryClaim = {
  admit(id: string, state: BrowserHostLeaseState, cancel: () => void): void
  validate(state: BrowserHostLeaseState): void
  commit(
    state: BrowserHostLeaseState,
    placement: RuntimeBrowserClientPlacement,
    replace: () => void
  ): void
  failed(
    placement: RuntimeBrowserClientPlacement,
    executionHostKey: string,
    releaseGrant: () => void
  ): boolean
  finish(): void
}

export function claimLegacyPageRecovery(
  owner: {
    records: Map<string, InitializationRecord>
    placements: BrowserHostPagePlacementRegistry
    requireState(state: BrowserHostLeaseState): void
    removeRecord(record: InitializationRecord): void
    cleanup(
      record: InitializationRecord,
      state: BrowserHostLeaseState,
      releaseGrant: () => void,
      isCurrent: () => boolean
    ): void
  },
  state: BrowserHostLeaseState,
  input: BrowserHostLegacyPageRecoveryInput
): BrowserHostLegacyPageRecoveryClaim | undefined {
  const record = owner.records.get(input.browserPageId)
  if (!record) {
    return undefined
  }
  const connection = state.connectionToken
  const ledger = state.commandLedger
  let attempt: InitializationRecord['legacyAttempt']
  const validate = (
    current: BrowserHostLeaseState,
    placement?: RuntimeBrowserClientPlacement
  ): void => {
    owner.requireState(state)
    const live = owner.placements.getPlacement(input.browserPageId)
    if (
      current !== state ||
      state.connectionToken !== connection ||
      state.commandLedger !== ledger ||
      owner.records.get(input.browserPageId) !== record ||
      record.closed ||
      record.stopped ||
      !record.authorityRetired ||
      record.target ||
      record.operation ||
      record.successor ||
      record.releaseCleanup ||
      record.legacyAttempt !== attempt ||
      record.browserProfileId !== input.browserProfileId ||
      record.workspaceId !== input.workspaceId ||
      record.pairedDeviceId !== state.lease.pairedDeviceId ||
      !sameInitializationPlacement(record.expected, input.expected) ||
      !input.isCurrent() ||
      (live !== undefined && (!placement || !sameInitializationPlacement(live, placement)))
    ) {
      throw new Error('browser_page_replacement_requires_retirement')
    }
  }
  validate(state)
  return {
    admit(id, current, cancel) {
      if (id !== input.browserPageId || attempt) {
        throw new Error('browser_page_replacement_requires_retirement')
      }
      validate(current)
      attempt = { state, cancel }
      record.legacyAttempt = attempt
      record.scope = state
    },
    validate(current) {
      validate(current)
    },
    commit(current, placement, replace) {
      validate(current, placement)
      replace()
      record.legacyAttempt = undefined
      record.scope = undefined
      owner.removeRecord(record)
    },
    failed(placement, executionHostKey, releaseGrant) {
      if (
        !attempt ||
        owner.records.get(input.browserPageId) !== record ||
        record.legacyAttempt !== attempt ||
        ledger?.isClosed()
      ) {
        return false
      }
      try {
        owner.requireState(state)
      } catch {
        return false
      }
      record.legacyAttempt = undefined
      record.browserHostClientId = state.lease.browserHostClientId
      record.authorityRetired = false
      record.closed ||= !input.isCurrent()
      record.target = {
        ...placement,
        authorityRuntimeId: state.lease.authorityRuntimeId,
        authorityEpoch: state.lease.authorityEpoch
      }
      record.targetExecutionHostKey = executionHostKey
      record.releaseCleanup = owner.placements.claimClientPageCleanup(input.browserPageId)
      owner.cleanup(record, state, releaseGrant, input.isCurrent)
      return true
    },
    finish() {
      if (record.legacyAttempt === attempt && attempt) {
        record.legacyAttempt = undefined
        record.scope = undefined
        if (record.closed && owner.records.get(input.browserPageId) === record) {
          owner.removeRecord(record)
        }
      }
    }
  }
}
