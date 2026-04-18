type ResolveRenderer = (browserTabId: string) => Electron.WebContents | null;
export declare function setupGuestContextMenu(args: {
    browserTabId: string;
    guest: Electron.WebContents;
    resolveRenderer: ResolveRenderer;
}): () => void;
export declare function setupGrabShortcutForwarding(args: {
    browserTabId: string;
    guest: Electron.WebContents;
    resolveRenderer: ResolveRenderer;
    hasActiveGrabOp: (browserTabId: string) => boolean;
}): () => void;
export declare function setupGuestShortcutForwarding(args: {
    browserTabId: string;
    guest: Electron.WebContents;
    resolveRenderer: ResolveRenderer;
}): () => void;
export declare function resolveRendererWebContents(rendererWebContentsIdByTabId: ReadonlyMap<string, number>, browserTabId: string): Electron.WebContents | null;
export {};
