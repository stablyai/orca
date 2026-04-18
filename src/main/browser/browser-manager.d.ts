import type { BrowserGrabCancelReason, BrowserGrabPayload, BrowserGrabRect, BrowserGrabResult, BrowserGrabScreenshot } from '../../shared/browser-grab-types';
export type BrowserGuestRegistration = {
    browserPageId?: string;
    browserTabId?: string;
    workspaceId?: string;
    webContentsId: number;
    rendererWebContentsId: number;
};
declare class BrowserManager {
    private readonly webContentsIdByTabId;
    private readonly tabIdByWebContentsId;
    private readonly rendererWebContentsIdByTabId;
    private readonly contextMenuCleanupByTabId;
    private readonly grabShortcutCleanupByTabId;
    private readonly shortcutForwardingCleanupByTabId;
    private readonly policyAttachedGuestIds;
    private readonly policyCleanupByGuestId;
    private readonly pendingLoadFailuresByGuestId;
    private readonly pendingPermissionEventsByGuestId;
    private readonly pendingPopupEventsByGuestId;
    private readonly pendingDownloadIdsByGuestId;
    private readonly downloadsById;
    private readonly grabSessionController;
    private resolveBrowserTabIdForGuestWebContentsId;
    private resolveRendererForBrowserTab;
    attachGuestPolicies(guest: Electron.WebContents): void;
    registerGuest({ browserPageId, browserTabId: legacyBrowserTabId, webContentsId, rendererWebContentsId }: BrowserGuestRegistration): void;
    unregisterGuest(browserTabId: string): void;
    unregisterAll(): void;
    getGuestWebContentsId(browserTabId: string): number | null;
    notifyPermissionDenied(args: {
        guestWebContentsId: number;
        permission: string;
        rawUrl: string;
    }): void;
    handleGuestWillDownload(args: {
        guestWebContentsId: number;
        item: Electron.DownloadItem;
    }): void;
    getDownloadPrompt(downloadId: string, senderWebContentsId: number): {
        filename: string;
    } | null;
    acceptDownload(args: {
        downloadId: string;
        senderWebContentsId: number;
        savePath: string;
    }): {
        ok: true;
    } | {
        ok: false;
        reason: string;
    };
    cancelDownload(args: {
        downloadId: string;
        senderWebContentsId: number;
    }): boolean;
    openDevTools(browserTabId: string): Promise<boolean>;
    /**
     * Validates that a caller (identified by sender webContentsId) owns the
     * given browserTabId. Returns the guest WebContents or null.
     */
    getAuthorizedGuest(browserTabId: string, senderWebContentsId: number): Electron.WebContents | null;
    /** Returns true if a grab operation is currently active for this tab. */
    hasActiveGrabOp(browserTabId: string): boolean;
    /**
     * Enable or disable grab mode for a browser tab. When enabled, injects the
     * overlay runtime into the guest. When disabled, cancels any active grab op.
     */
    setGrabMode(browserTabId: string, enabled: boolean, guest: Electron.WebContents): Promise<boolean>;
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
    /**
     * Cancel an active grab operation for the given tab.
     */
    cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void;
    /**
     * Capture a screenshot of the guest surface and optionally crop it to
     * the given CSS-pixel rect.
     */
    captureSelectionScreenshot(_browserTabId: string, rect: BrowserGrabRect, guest: Electron.WebContents): Promise<BrowserGrabScreenshot | null>;
    /**
     * Extract the payload for the currently hovered element without disrupting
     * the active grab overlay or awaitClick listener. Used by keyboard shortcuts
     * that let the user copy content while hovering, before clicking.
     */
    extractHoverPayload(_browserTabId: string, guest: Electron.WebContents): Promise<BrowserGrabPayload | null>;
    private setupContextMenu;
    private setupGrabShortcut;
    private setupShortcutForwarding;
    private forwardOrQueueGuestLoadFailure;
    private forwardOrQueuePermissionDenied;
    private flushPendingPermissionEvents;
    private sendPermissionDenied;
    private forwardOrQueuePopupEvent;
    private flushPendingPopupEvents;
    private sendPopupEvent;
    private bindDownloadToTab;
    private flushPendingDownloadRequests;
    private sendDownloadRequested;
    private sendDownloadProgress;
    private sendDownloadFinished;
    private cancelDownloadInternal;
    private flushPendingLoadFailure;
    private sendGuestLoadFailure;
    private openLinkInOrcaTab;
}
export declare const browserManager: BrowserManager;
export {};
