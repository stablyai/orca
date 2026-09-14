import type {
  BrowserClickResult,
  BrowserDragResult,
  BrowserHoverResult
} from '../../shared/runtime-types'
import { CdpBridgeCommandModule } from './cdp-bridge-command-module'

export class CdpPointerCommands extends CdpBridgeCommandModule {
  click(element: string): Promise<BrowserClickResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)

      await this.scrollIntoView(refSender, node.backendDOMNodeId)
      const localCenter = await this.getElementCenter(refSender, node.backendDOMNodeId)
      const { cx, cy } = await this.getPageCoordinates(guest, node, localCenter.cx, localCenter.cy)

      // Why: mouseMoved fires mouseenter/mouseover so sites reveal hover-dependent menus/targets before the click lands.
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
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      await this.scrollIntoView(refSender, node.backendDOMNodeId)
      const localCenter = await this.getElementCenter(refSender, node.backendDOMNodeId)
      const { cx, cy } = await this.getPageCoordinates(guest, node, localCenter.cx, localCenter.cy)

      await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })

      return { hovered: element }
    })
  }

  drag(fromElement: string, toElement: string): Promise<BrowserDragResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const fromNode = await this.resolveRef(guest, sender, fromElement)
      const toNode = await this.resolveRef(guest, sender, toElement)
      const fromSender = this.senderForRef(guest, fromNode)
      const toSender = this.senderForRef(guest, toNode)

      await this.scrollIntoView(fromSender, fromNode.backendDOMNodeId)
      const fromLocal = await this.getElementCenter(fromSender, fromNode.backendDOMNodeId)
      const from = await this.getPageCoordinates(guest, fromNode, fromLocal.cx, fromLocal.cy)
      const toLocal = await this.getElementCenter(toSender, toNode.backendDOMNodeId)
      const to = await this.getPageCoordinates(guest, toNode, toLocal.cx, toLocal.cy)

      // Why: interpolate the drag so intermediate elements fire dragenter/dragover, which many drag-and-drop libs require.
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
