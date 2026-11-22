import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import type { BrowserSetGrabModeResult } from '../../../shared/browser/element-grab/browser-grab-types'
import {
  grabDocumentScope,
  retireGrabOverlay,
  type GrabDocumentScope
} from './grab-guest-execution'
import {
  grabModeOperationByPageId,
  retireGrabModeAdmission,
  queueGrabModeOperation,
  supersededGrabMode
} from './browser-grab-mode-admission'

type ModeOwner = { requestId?: string; identity: string; scope?: GrabDocumentScope }
type ModeOptions = {
  requestId?: string
  paletteKeys?: boolean
  owner?: string
  destination?: Electron.WebContents
  onPolicyRetired?: () => void
}
const owners = new Map<string, ModeOwner>()
const intents = new Map<string, { enabled: boolean }>()

export function resetGrabModeState(): void {
  owners.clear()
  intents.clear()
  for (const state of grabModeOperationByPageId.values()) {
    retireGrabModeAdmission(state)
  }
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  owners.delete(browserPageId)
  intents.delete(browserPageId)
  const state = grabModeOperationByPageId.get(browserPageId)
  if (state) {
    retireGrabModeAdmission(state)
  }
  grabModeOperationByPageId.delete(browserPageId)
}

/** The same bounded request/document owner for a local renderer or an authorized runtime viewer. */
export async function setBrowserGrabMode(
  browserPageId: string,
  enabled: boolean,
  resolveGuest: () => Electron.WebContents | null,
  waitForGuest?: (signal: AbortSignal) => Promise<void>,
  options: ModeOptions = {}
): Promise<BrowserSetGrabModeResult> {
  const previous = owners.get(browserPageId)
  const identity = options.owner ?? 'runtime'
  if (previous && previous.identity !== identity && !resolveGuest()) {
    return { ok: false, reason: 'not-authorized' }
  }
  const owner: ModeOwner = { requestId: options.requestId, identity }
  const intent = { enabled }
  owners.set(browserPageId, owner)
  intents.set(browserPageId, intent)
  const isCurrent = (): boolean => intents.get(browserPageId) === intent
  return queueGrabModeOperation(browserPageId, async (signal) => {
    let guest = resolveGuest()
    if (!guest && enabled && waitForGuest) {
      await waitForGuest(signal).catch(() => {})
      guest = resolveGuest()
    }
    if (!isCurrent() || signal.aborted) {
      return supersededGrabMode()
    }
    if (!guest) {
      return enabled ? supersededGrabMode() : { ok: true, clean: false }
    }
    owner.scope = grabDocumentScope(guest)
    const success = await browserManager.setGrabMode(
      browserPageId,
      enabled,
      guest,
      options.destination,
      () => resolveGuest() === guest,
      signal,
      () => {
        if (owners.get(browserPageId) === owner) {
          options.onPolicyRetired?.()
        }
      },
      options.paletteKeys
    )
    if (!isCurrent() || signal.aborted) {
      return supersededGrabMode()
    }
    return success ? { ok: true, clean: !enabled } : { ok: false, reason: 'injection-failed' }
  }).finally(() => {
    if (isCurrent()) {
      intents.delete(browserPageId)
    }
  })
}

export function isCurrentBrowserGrabRequest(
  browserPageId: string,
  guest: Electron.WebContents,
  requestId: string | undefined,
  identity: string
): boolean {
  if (requestId === undefined) {
    return true
  }
  const owner = owners.get(browserPageId)
  return (
    owner?.requestId === requestId &&
    owner.identity === identity &&
    owner.scope?.current === true &&
    owner.scope === grabDocumentScope(guest)
  )
}

export function cancelBrowserGrabMode(
  browserPageId: string,
  resolveGuest: () => Electron.WebContents | null,
  requestId: string | undefined,
  identity: string
): boolean {
  const owner = owners.get(browserPageId)
  if (requestId !== undefined) {
    if (!owner || owner.requestId !== requestId || owner.identity !== identity) {
      return false
    }
  } else if (!resolveGuest()) {
    return false
  }
  const admission = grabModeOperationByPageId.get(browserPageId)
  if (admission) {
    retireGrabModeAdmission(admission)
  }
  intents.delete(browserPageId)
  if (owner?.scope) {
    retireGrabOverlay(owner.scope)
  }
  owners.delete(browserPageId)
  browserManager.cancelGrabOp(browserPageId, 'user')
  return true
}
