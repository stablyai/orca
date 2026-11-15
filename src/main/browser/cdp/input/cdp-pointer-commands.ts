import type {
  BrowserClickResult,
  BrowserDragResult,
  BrowserHoverResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type { CdpBridgeState } from '../commands/cdp-bridge-state'
import type { CdpDebuggerLifecycle } from '../debugger/cdp-debugger-lifecycle'
import type { CdpRefResolution } from '../commands/cdp-ref-resolution'

export class CdpPointerCommands {
  constructor(
    private readonly bridgeState: CdpBridgeState,
    private readonly debuggerLifecycle: CdpDebuggerLifecycle,
    private readonly refResolution: CdpRefResolution
  ) {}

  click(element: string): Promise<BrowserClickResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)

      await this.refResolution.scrollIntoView(refSender, node.backendDOMNodeId)
      const localCenter = await this.refResolution.getElementCenter(
        refSender,
        node.backendDOMNodeId
      )
      const { cx, cy } = await this.refResolution.getPageCoordinates(
        guest,
        node,
        localCenter.cx,
        localCenter.cy
      )

      // Reveal hover-dependent targets before clicking.
      await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
      await sender('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1
      })
      await sender('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1
      })

      return { clicked: element }
    })
  }

  hover(element: string): Promise<BrowserHoverResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)
      await this.refResolution.scrollIntoView(refSender, node.backendDOMNodeId)
      const localCenter = await this.refResolution.getElementCenter(
        refSender,
        node.backendDOMNodeId
      )
      const { cx, cy } = await this.refResolution.getPageCoordinates(
        guest,
        node,
        localCenter.cx,
        localCenter.cy
      )

      await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })

      return { hovered: element }
    })
  }

  drag(fromElement: string, toElement: string): Promise<BrowserDragResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const fromNode = await this.refResolution.resolveRef(guest, sender, fromElement)
      const toNode = await this.refResolution.resolveRef(guest, sender, toElement)
      const fromSender = this.refResolution.senderForRef(guest, fromNode)
      const toSender = this.refResolution.senderForRef(guest, toNode)

      await this.refResolution.scrollIntoView(fromSender, fromNode.backendDOMNodeId)
      const fromLocal = await this.refResolution.getElementCenter(
        fromSender,
        fromNode.backendDOMNodeId
      )
      const from = await this.refResolution.getPageCoordinates(
        guest,
        fromNode,
        fromLocal.cx,
        fromLocal.cy
      )
      const toLocal = await this.refResolution.getElementCenter(toSender, toNode.backendDOMNodeId)
      const to = await this.refResolution.getPageCoordinates(guest, toNode, toLocal.cx, toLocal.cy)

      // Intermediate drag events are required by many drag-and-drop libraries.
      await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.cx, y: from.cy })
      await sender('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: from.cx,
        y: from.cy,
        button: 'left'
      })

      const steps = 10
      for (let i = 1; i <= steps; i++) {
        const x = from.cx + ((to.cx - from.cx) * i) / steps
        const y = from.cy + ((to.cy - from.cy) * i) / steps
        await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1 })
        await new Promise((r) => setTimeout(r, 10))
      }

      await sender('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: to.cx,
        y: to.cy,
        button: 'left'
      })

      return { dragged: { from: fromElement, to: toElement } }
    })
  }
}
