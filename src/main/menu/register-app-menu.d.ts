type RegisterAppMenuOptions = {
    onOpenSettings: () => void;
    onCheckForUpdates: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onZoomReset: () => void;
    onToggleStatusBar: () => void;
};
export declare function registerAppMenu({ onOpenSettings, onCheckForUpdates, onZoomIn, onZoomOut, onZoomReset, onToggleStatusBar }: RegisterAppMenuOptions): void;
export {};
