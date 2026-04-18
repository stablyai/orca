import { BrowserWindow } from 'electron';
import type { Store } from '../persistence';
type CreateMainWindowOptions = {
    /** Returns true when a manual app.quit() (Cmd+Q) is in progress. The close
     *  handler sends this to the renderer so it can skip the running-process
     *  confirmation dialog and proceed directly to buffer capture + close. */
    getIsQuitting?: () => boolean;
    /** Notifies the caller when the renderer vetoes unload. Why: a prevented
     *  beforeunload cancels the in-flight app.quit(), so the app-level quit
     *  latch must be cleared or later window closes will be misclassified as
     *  quit attempts. */
    onQuitAborted?: () => void;
};
export declare function createMainWindow(store: Store | null, opts?: CreateMainWindowOptions): BrowserWindow;
export {};
