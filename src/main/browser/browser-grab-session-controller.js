import { buildGuestOverlayScript } from './grab-guest-script';
import { clampGrabPayload } from './browser-grab-payload';
/** Hard timeout for an armed grab operation to prevent indefinite hangs. */
const GRAB_OP_TIMEOUT_MS = 120_000;
export class BrowserGrabSessionController {
    activeGrabOps = new Map();
    hasActiveGrabOp(browserTabId) {
        return this.activeGrabOps.has(browserTabId);
    }
    cancelGrabOp(browserTabId, reason) {
        const op = this.activeGrabOps.get(browserTabId);
        if (!op) {
            return;
        }
        // Why: settleOnce (op.resolve) already calls op.cleanup() and deletes the
        // map entry. Calling them again here would double-inject the teardown script.
        op.resolve({ opId: op.opId, kind: 'cancelled', reason });
    }
    cancelAll(reason) {
        for (const browserTabId of this.activeGrabOps.keys()) {
            this.cancelGrabOp(browserTabId, reason);
        }
    }
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
    awaitGrabSelection(browserTabId, opId, guest) {
        // Why: only one active grab operation per tab prevents race conditions
        // where a late click from a previous operation resolves the wrong Promise.
        const existing = this.activeGrabOps.get(browserTabId);
        if (existing) {
            // Why: skip teardown injection when replacing an op. The new op will
            // reuse the already-armed overlay. If we injected teardown here, it
            // would race with the new awaitClick script in the guest's JS queue
            // and destroy the overlay before the click handler is installed.
            existing.skipTeardown = true;
            existing.resolve({ opId: existing.opId, kind: 'cancelled', reason: 'user' });
        }
        return new Promise((resolve) => {
            const guestWebContentsId = guest.id;
            let settled = false;
            const settleOnce = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeoutId);
                // Why: when the user successfully selects an element, keep the guest
                // overlay visible so the highlight box persists while the renderer
                // shows the copy menu. Teardown happens later when the renderer calls
                // setGrabMode(false) or re-arms with a fresh armAndAwait cycle.
                op.cleanup(result.kind === 'selected' || result.kind === 'context-selected');
                this.activeGrabOps.delete(browserTabId);
                resolve(result);
            };
            // Why: the guest overlay runtime handles the click in-page and calls
            // __orcaGrabResolve() which is wired by the 'awaitClick' script to
            // resolve the executeJavaScript Promise with the extracted payload.
            // Main just needs to run that script and await its result.
            const awaitGuestClick = async () => {
                try {
                    const rawPayload = await guest.executeJavaScript(buildGuestOverlayScript('awaitClick'));
                    if (!rawPayload || typeof rawPayload !== 'object') {
                        settleOnce({ opId, kind: 'cancelled', reason: 'user' });
                        return;
                    }
                    // Why: the guest wraps right-click results in { __orcaContextMenu, payload }
                    // so the renderer can show the full action dropdown instead of auto-copying.
                    const isContextMenu = '__orcaContextMenu' in rawPayload &&
                        rawPayload.__orcaContextMenu === true;
                    const payloadSource = isContextMenu
                        ? rawPayload.payload
                        : rawPayload;
                    const payload = clampGrabPayload(payloadSource);
                    if (!payload) {
                        settleOnce({ opId, kind: 'error', reason: 'Guest returned invalid payload structure' });
                        return;
                    }
                    settleOnce({
                        opId,
                        kind: isContextMenu ? 'context-selected' : 'selected',
                        payload
                    });
                }
                catch (err) {
                    const message = err instanceof Error ? err.message : 'Selection failed';
                    if (message.includes('cancelled')) {
                        settleOnce({ opId, kind: 'cancelled', reason: 'user' });
                    }
                    else {
                        settleOnce({ opId, kind: 'error', reason: message });
                    }
                }
            };
            // Why: only cancel on main-frame navigations. Subframe navigations
            // (e.g., iframe ads loading) should not spuriously cancel the grab.
            const handleNavigation = (_event, _url, _isInPlace, isMainFrame) => {
                if (isMainFrame) {
                    settleOnce({ opId, kind: 'cancelled', reason: 'navigation' });
                }
            };
            const handleDestroyed = () => {
                settleOnce({ opId, kind: 'cancelled', reason: 'evicted' });
            };
            const timeoutId = setTimeout(() => {
                settleOnce({ opId, kind: 'cancelled', reason: 'timeout' });
            }, GRAB_OP_TIMEOUT_MS);
            guest.on('did-start-navigation', handleNavigation);
            guest.on('destroyed', handleDestroyed);
            const cleanup = (preserveOverlay) => {
                try {
                    guest.off('did-start-navigation', handleNavigation);
                    guest.off('destroyed', handleDestroyed);
                }
                catch {
                    // Why: the guest may already be destroyed during teardown.
                    // Cleanup is best-effort.
                }
                // Why: skip teardown injection when (a) the op is being replaced by a
                // new op (skipTeardown), or (b) the selection succeeded and the overlay
                // should stay visible while the copy menu is shown (preserveOverlay).
                if (op.skipTeardown || preserveOverlay) {
                    return;
                }
                try {
                    if (!guest.isDestroyed()) {
                        void guest.executeJavaScript(buildGuestOverlayScript('teardown'));
                    }
                }
                catch {
                    // Best-effort overlay removal
                }
            };
            const op = {
                opId,
                browserTabId,
                guestWebContentsId,
                resolve: settleOnce,
                cleanup
            };
            this.activeGrabOps.set(browserTabId, op);
            void awaitGuestClick();
        });
    }
}
