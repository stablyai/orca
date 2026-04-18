import { BrowserWindow } from 'electron';
import type { UpdateStatus } from '../shared/types';
export declare function getUpdateStatus(): UpdateStatus;
export declare function checkForUpdates(): void;
/** Menu-triggered check — delegates feedback to renderer toasts via userInitiated flag */
export declare function checkForUpdatesFromMenu(): void;
export declare function isQuittingForUpdate(): boolean;
export declare function quitAndInstall(): void;
export declare function dismissNudge(): void;
export declare function setupAutoUpdater(mainWindow: BrowserWindow, opts?: {
    getLastUpdateCheckAt?: () => number | null;
    onBeforeQuit?: () => void;
    setLastUpdateCheckAt?: (timestamp: number) => void;
    getPendingUpdateNudgeId?: () => string | null;
    getDismissedUpdateNudgeId?: () => string | null;
    setPendingUpdateNudgeId?: (id: string | null) => void;
    setDismissedUpdateNudgeId?: (id: string | null) => void;
}): void;
export declare function downloadUpdate(): void;
