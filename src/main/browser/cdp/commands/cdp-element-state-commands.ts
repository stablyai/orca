import type {
  BrowserCheckResult,
  BrowserSelectResult,
  BrowserUploadResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import type { CdpBridgeState } from './cdp-bridge-state'
import type { CdpDebuggerLifecycle } from '../debugger/cdp-debugger-lifecycle'
import type { CdpRefResolution } from './cdp-ref-resolution'

export class CdpElementStateCommands {
  constructor(
    private readonly bridgeState: CdpBridgeState,
    private readonly debuggerLifecycle: CdpDebuggerLifecycle,
    private readonly refResolution: CdpRefResolution
  ) {}

  uploadFile(element: string, filePaths: string[]): Promise<BrowserUploadResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)
      await refSender('DOM.setFileInputFiles', {
        files: filePaths,
        backendNodeId: node.backendDOMNodeId
      })

      return { uploaded: filePaths.length }
    })
  }

  select(element: string, value: string): Promise<BrowserSelectResult> {
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)
      const objectId = await this.refResolution.resolveNodeObjectId(refSender, node.backendDOMNodeId)

      // Labels allow selection when option values are opaque IDs.
      await refSender('Runtime.callFunctionOn', {
        objectId,
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
    return this.bridgeState.enqueueCommand(async () => {
      const guest = this.bridgeState.getActiveGuest()
      const sender = this.debuggerLifecycle.makeCdpSender(guest)
      await this.debuggerLifecycle.ensureDebuggerAttached(guest)

      const node = await this.refResolution.resolveRef(guest, sender, element)
      const refSender = this.refResolution.senderForRef(guest, node)

      const objectId = await this.refResolution.resolveNodeObjectId(refSender, node.backendDOMNodeId)

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callFunctionOn with returnByValue echoes the function's boolean return as result.value.
      const { result: currentState } = (await refSender('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return this.checked; }',
        returnByValue: true
      })) as { result: { value: boolean } }

      if (currentState.value !== checked) {
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

        // Some custom checkboxes need a programmatic click after coordinate delivery.
        try {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callFunctionOn with returnByValue echoes the function's boolean return as result.value.
          const { result: afterState } = (await refSender('Runtime.callFunctionOn', {
            objectId,
            functionDeclaration: 'function() { return this.checked; }',
            returnByValue: true
          })) as { result: { value: boolean } }

          if (afterState.value !== checked) {
            await refSender('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration: 'function() { this.click(); }'
            })
          }
        } catch {
          // Re-rendering can invalidate the object ID after the click has been sent.
        }
      }

      return { checked }
    })
  }
}
