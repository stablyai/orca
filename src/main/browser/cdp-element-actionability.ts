import type { WebContents } from 'electron'
import { BrowserError } from './browser-error'
import type { CdpBridgeState } from './cdp-bridge-state'
import type { CdpDebuggerLifecycle } from './cdp-debugger-lifecycle'
import {
  isUsableBoxQuad,
  mapViewportPointToQuad,
  readElementBoxModel,
  resolveIframeOwnerGeometry
} from './cdp-iframe-projective-geometry'
import type { CdpCommandSender, RefEntry } from './snapshot-engine'

export type ElementActionabilityRequirements = {
  pointerCenter?: { cx: number; cy: number }
  requireEnabled?: boolean
  requireEditable?: boolean
}

const INTERACTABILITY_CHECK = `function(cx, cy, requireEnabled, requireEditable) {
  if (!this || typeof this !== 'object') return 'missing';
  if (requireEnabled && (this.disabled === true || (typeof this.matches === 'function' && this.matches(':disabled')))) return 'disabled';
  if (requireEnabled) {
    let current = this;
    while (current) {
      if (current.inert === true) return 'disabled';
      if (typeof current.getAttribute === 'function' && current.getAttribute('aria-disabled')?.toLowerCase() === 'true') return 'disabled';
      const assignedSlot = current.assignedSlot;
      if (assignedSlot) {
        current = assignedSlot;
        continue;
      }
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
      current = root?.host && root.host !== current ? root.host : null;
    }
  }
  if (requireEditable) {
    const tag = typeof this.tagName === 'string' ? this.tagName.toLowerCase() : '';
    const type = typeof this.type === 'string' ? this.type.toLowerCase() : '';
    const nonTextInput = /^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/;
    const editable = this.isContentEditable === true || tag === 'textarea' || (tag === 'input' && !nonTextInput.test(type));
    if (!editable) return 'not-editable';
  }
  if (requireEditable && (this.readOnly === true || (typeof this.getAttribute === 'function' && this.getAttribute('aria-readonly')?.toLowerCase() === 'true'))) return 'readonly';
  if (this.hidden === true || this.type === 'hidden') return 'hidden';
  const style = getComputedStyle(this);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return 'hidden';
  if (typeof cx === 'number' && typeof cy === 'number') {
    const root = typeof this.getRootNode === 'function' ? this.getRootNode() : null;
    const hitTester = root && typeof root.elementFromPoint === 'function' ? root : this.ownerDocument;
    const hit = hitTester.elementFromPoint(cx, cy);
    let current = hit;
    while (current && current !== this) {
      if (current.assignedSlot) {
        current = current.assignedSlot;
        continue;
      }
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      const currentRoot = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
      current = currentRoot?.host && currentRoot.host !== current ? currentRoot.host : null;
    }
    if (current !== this) return 'obscured';
  }
  return '';
}`

export class CdpElementActionability {
  constructor(
    private readonly bridgeState: CdpBridgeState,
    private readonly debuggerLifecycle: CdpDebuggerLifecycle
  ) {}

  async assertElementInteractable(
    sender: CdpCommandSender,
    backendNodeId: number,
    ref: string,
    requirements: ElementActionabilityRequirements = {}
  ): Promise<void> {
    const { nodeId } = (await sender('DOM.requestNode', { backendNodeId })) as { nodeId: number }
    const { object } = (await sender('DOM.resolveNode', { nodeId })) as {
      object: { objectId: string }
    }
    const { result, exceptionDetails } = (await sender('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: INTERACTABILITY_CHECK,
      arguments: [
        { value: requirements.pointerCenter?.cx ?? null },
        { value: requirements.pointerCenter?.cy ?? null },
        { value: requirements.requireEnabled === true },
        { value: requirements.requireEditable === true }
      ],
      returnByValue: true
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (exceptionDetails) {
      throw new BrowserError('browser_cdp_error', `Could not check element ${ref} interactability.`)
    }
    throwIfInteractabilityFailed(ref, typeof result?.value === 'string' ? result.value : '')
  }

  async getElementCenter(
    sender: CdpCommandSender,
    backendNodeId: number,
    ref?: string
  ): Promise<{ cx: number; cy: number }> {
    const model = await readElementBoxModel(
      sender,
      backendNodeId,
      `Element ${ref ?? 'ref'} has no layout box. Re-snapshot and pick a visible control.`
    )
    const quad = [model?.content, model?.padding, model?.border].find(isUsableBoxQuad)
    if (!quad) {
      throw new BrowserError(
        'browser_element_not_interactable',
        `Element ${ref ?? 'ref'} has zero size and cannot be interacted with.`
      )
    }
    const xs = [quad[0], quad[2], quad[4], quad[6]]
    const ys = [quad[1], quad[3], quad[5], quad[7]]
    return {
      cx: xs.reduce((sum, value) => sum + value, 0) / xs.length,
      cy: ys.reduce((sum, value) => sum + value, 0) / ys.length
    }
  }

  async getPageCoordinates(
    guest: WebContents,
    refEntry: RefEntry,
    localCx: number,
    localCy: number
  ): Promise<{ cx: number; cy: number }> {
    if (!refEntry.sessionId) {
      return { cx: localCx, cy: localCy }
    }
    let cx = localCx
    let cy = localCy
    let sessionId: string | null = refEntry.sessionId
    while (sessionId) {
      const geometry = await resolveIframeOwnerGeometry(this.geometryHost(), guest, sessionId)
      const parentPoint = mapViewportPointToQuad(
        geometry.contentQuad,
        cx,
        cy,
        geometry.viewportWidth,
        geometry.viewportHeight
      )
      if (!parentPoint) {
        throw new BrowserError(
          'browser_element_not_interactable',
          'The iframe transform cannot be mapped safely. Re-snapshot and retry.'
        )
      }
      const { cx: nextCx, cy: nextCy } = parentPoint
      await this.assertIframeReceivesPointer(
        this.debuggerLifecycle.makeCdpSender(guest, geometry.parentSessionId ?? undefined),
        geometry.backendNodeId,
        nextCx,
        nextCy
      )
      cx = nextCx
      cy = nextCy
      sessionId = geometry.parentSessionId
    }
    return { cx, cy }
  }

  private async assertIframeReceivesPointer(
    sender: CdpCommandSender,
    backendNodeId: number,
    cx: number,
    cy: number
  ): Promise<void> {
    const { object } = (await sender('DOM.resolveNode', { backendNodeId })) as {
      object?: { objectId?: string }
    }
    if (!object?.objectId) {
      throw new BrowserError(
        'browser_element_not_interactable',
        'Could not resolve the iframe owner. Re-snapshot and retry.'
      )
    }
    const { result, exceptionDetails } = (await sender('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(cx, cy) {
        const root = typeof this.getRootNode === 'function' ? this.getRootNode() : this.ownerDocument;
        const hit = root && typeof root.elementFromPoint === 'function' ? root.elementFromPoint(cx, cy) : null;
        return hit === this || (hit && typeof this.contains === 'function' && this.contains(hit));
      }`,
      arguments: [{ value: cx }, { value: cy }],
      returnByValue: true
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (exceptionDetails) {
      throw new BrowserError(
        'browser_cdp_error',
        'Could not check whether the iframe receives pointer input.'
      )
    }
    if (result?.value !== true) {
      throw new BrowserError(
        'browser_element_not_interactable',
        'The iframe is covered at the target point. Re-snapshot and pick an unobscured control.'
      )
    }
  }

  private geometryHost() {
    return {
      resolveTabId: (webContentsId: number) => this.bridgeState.resolveTabId(webContentsId),
      getOrCreateTabState: (tabId: string) => this.bridgeState.getOrCreateTabState(tabId),
      makeCdpSender: (guest: WebContents, sessionId?: string) =>
        this.debuggerLifecycle.makeCdpSender(guest, sessionId)
    }
  }
}

function throwIfInteractabilityFailed(ref: string, reason: string): void {
  if (reason === 'disabled') {
    throw new BrowserError(
      'browser_element_not_interactable',
      `Element ${ref} is disabled and cannot be interacted with.`
    )
  }
  if (reason === 'hidden' || reason === 'missing') {
    throw new BrowserError(
      'browser_element_not_interactable',
      `Element ${ref} is not visible for interaction. Re-snapshot or scroll it into view.`
    )
  }
  if (reason === 'readonly') {
    throw new BrowserError(
      'browser_element_not_interactable',
      `Element ${ref} is readonly and cannot be filled.`
    )
  }
  if (reason === 'not-editable') {
    throw new BrowserError(
      'browser_element_not_interactable',
      `Element ${ref} is not an editable input.`
    )
  }
  if (reason === 'obscured') {
    throw new BrowserError(
      'browser_element_not_interactable',
      `Element ${ref} cannot receive pointer input at its center. Re-snapshot and pick an unobscured control.`
    )
  }
}
