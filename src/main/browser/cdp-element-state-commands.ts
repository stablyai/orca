import type {
  BrowserCheckResult,
  BrowserSelectResult,
  BrowserUploadResult
} from '../../shared/runtime-types'
import { CdpBridgeCommandModule } from './cdp-bridge-command-module'

export class CdpElementStateCommands extends CdpBridgeCommandModule {
  uploadFile(element: string, filePaths: string[]): Promise<BrowserUploadResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      await refSender('DOM.setFileInputFiles', {
        files: filePaths,
        backendNodeId: node.backendDOMNodeId
      })

      return { uploaded: filePaths.length }
    })
  }

  select(element: string, value: string): Promise<BrowserSelectResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      const { nodeId } = (await refSender('DOM.requestNode', {
        backendNodeId: node.backendDOMNodeId
      })) as { nodeId: number }

      const { object } = (await refSender('DOM.resolveNode', { nodeId })) as {
        object: { objectId: string }
      }

      // Why: match on label (textContent) and value so opaque option IDs still select; also handles combobox via click.
      await refSender('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function(val) {
          if (this.options) {
            for (const opt of this.options) {
              if (opt.value === val || opt.textContent.trim() === val) {
                this.value = opt.value;
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
                return;
              }
            }
            this.value = val;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const opts = this.querySelectorAll('[role="option"], li, [data-value]');
            for (const opt of opts) {
              const text = opt.textContent ? opt.textContent.trim() : '';
              const dv = opt.getAttribute('data-value');
              if (text === val || dv === val) {
                opt.click();
                return;
              }
            }
          }
        }`,
        arguments: [{ value }]
      })

      return { selected: element }
    })
  }

  check(element: string, checked: boolean): Promise<BrowserCheckResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)

      const { nodeId } = (await refSender('DOM.requestNode', {
        backendNodeId: node.backendDOMNodeId
      })) as { nodeId: number }
      const { object } = (await refSender('DOM.resolveNode', { nodeId })) as {
        object: { objectId: string }
      }

      const { result: currentState } = (await refSender('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { return this.checked; }',
        returnByValue: true
      })) as { result: { value: boolean } }

      if (currentState.value !== checked) {
        await this.scrollIntoView(refSender, node.backendDOMNodeId)
        const localCenter = await this.getElementCenter(refSender, node.backendDOMNodeId)
        const { cx, cy } = await this.getPageCoordinates(
          guest,
          node,
          localCenter.cx,
          localCenter.cy
        )
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

        // Why: custom checkboxes may not toggle from a coordinate click; verify state and fall back to programmatic .click().
        try {
          const { result: afterState } = (await refSender('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function() { return this.checked; }',
            returnByValue: true
          })) as { result: { value: boolean } }

          if (afterState.value !== checked) {
            await refSender('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: 'function() { this.click(); }'
            })
          }
        } catch {
          // objectId stale after re-render — click was dispatched, accept the result
        }
      }

      return { checked }
    })
  }
}
