import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { RpcClient } from '../../transport/rpc-client'

export type PrTabSheet = 'merge' | 'reviewers' | 'createPr' | 'editTitle' | 'editDescription'
export type PrTabConfirm = 'close' | 'reopen' | 'unlink'

/**
 * One incarnation of what a tab request belongs to: the complete PR resource (or, for Create, the branch) in this
 * client and worktree. Equal PR numbers or branch strings do not make two incarnations equal; object identity does.
 */
export type PrTabScope = {
  readonly client: RpcClient | null
  readonly worktreeId: string
  readonly branch: string | null
  readonly resource: string | null
}

// Selected during render: equal fields keep the object, and any departure selects a fresh one, so A -> B -> A is A2.
export function useSelectedScope(next: PrTabScope): PrTabScope {
  const [scope, setScope] = useState(next)
  if (
    scope.client === next.client &&
    scope.worktreeId === next.worktreeId &&
    scope.branch === next.branch &&
    scope.resource === next.resource
  ) {
    return scope
  }
  setScope(next)
  return next
}

/** One opened sheet; its record is the presentation incarnation a late save or click is checked against. */
export type PrTabSheetRequest = {
  readonly kind: PrTabSheet
  readonly scope: PrTabScope
  readonly id: number
}
type ConfirmRequest = { readonly kind: PrTabConfirm; readonly scope: PrTabScope }

// Sheets and confirmations belong to the scope they opened for; a departure makes them ineligible at once and never
// retargets them, so the outgoing body, a late save or a stale confirm cannot act for the new PR.
export function usePrTabRequests(prScope: PrTabScope, branchScope: PrTabScope) {
  const scopeFor = (kind: PrTabSheet) => (kind === 'createPr' ? branchScope : prScope)
  const [opened, setOpened] = useState<PrTabSheetRequest | null>(null)
  const sheetRequest = opened && opened.scope === scopeFor(opened.kind) ? opened : null
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const confirmed = confirmRequest && confirmRequest.scope === prScope ? confirmRequest : null
  const latest = useRef({ sheetRequest, confirmed, scopeFor })
  useLayoutEffect(() => {
    latest.current = { sheetRequest, confirmed, scopeFor }
  })
  const nextId = useRef(0)
  const setSheet = useCallback((kind: PrTabSheet | null) => {
    nextId.current += 1
    setOpened(kind ? { kind, scope: latest.current.scopeFor(kind), id: nextId.current } : null)
  }, [])
  return {
    sheetRequest,
    sheet: sheetRequest?.kind ?? null,
    setSheet,
    /** The request is the committed open one; an outgoing or departed presentation owns nothing. */
    ownsSheet: useCallback(
      (request: PrTabSheetRequest) => latest.current.sheetRequest === request,
      []
    ),
    /** The request still belongs to the current resource, so its body may render while it animates closed. */
    inScope: (request: PrTabSheetRequest) => request.scope === scopeFor(request.kind),
    // A save or merge that lands late closes only its own request, never one opened since.
    closeSheetIf: useCallback((request: PrTabSheetRequest) => {
      if (latest.current.sheetRequest === request) {
        setOpened(null)
      }
    }, []),
    // A sheet closed by a departure must not come back when the user switches back.
    retireDepartedSheet: useCallback(() => {
      setOpened((current) =>
        current && current.scope === latest.current.scopeFor(current.kind) ? current : null
      )
    }, []),
    hasSheet: useCallback(() => latest.current.sheetRequest !== null, []),
    confirm: confirmed?.kind ?? null,
    setConfirm: useCallback((kind: PrTabConfirm | null) => {
      setConfirmRequest(kind ? { kind, scope: latest.current.scopeFor('merge') } : null)
    }, []),
    /** The confirmation still current at the click, or null for one its PR departed from. */
    takeConfirm: useCallback((): PrTabConfirm | null => {
      const current = latest.current.confirmed
      setConfirmRequest(null)
      return current?.kind ?? null
    }, [])
  }
}
