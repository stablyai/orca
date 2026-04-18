import type { BrowserGrabCancelReason, BrowserGrabResult } from '../../shared/browser-grab-types';
export declare class BrowserGrabSessionController {
    private readonly activeGrabOps;
    hasActiveGrabOp(browserTabId: string): boolean;
    cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void;
    cancelAll(reason: BrowserGrabCancelReason): void;
    /**
     * Await a single grab selection on the given tab. Returns a Promise that
     * resolves exactly once when the user clicks, cancels, or an error occurs.
     *
     * Why the click is handled in-guest rather than via main-side interception:
     * Electron's `before-input-event` only fires for keyboard events, not mouse
     * events on guest webContents. The design doc anticipated a main-owned
     * interceptor, but the spike showed this API gap. The fallback (documented
     * in the design doc) is to let the guest overlay's full-viewport hit-catcher
     * consume the click. The overlay calls `stopPropagation()` and
     * `preventDefault()` so the page underneath does not receive the event.
     * This is not a perfect guarantee (capture-phase listeners on window may
     * still fire), but it covers the vast majority of sites.
     */
    awaitGrabSelection(browserTabId: string, opId: string, guest: Electron.WebContents): Promise<BrowserGrabResult>;
}
