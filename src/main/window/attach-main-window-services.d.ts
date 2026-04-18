import type { BrowserWindow } from 'electron';
import type { Store } from '../persistence';
import type { OrcaRuntimeService } from '../runtime/orca-runtime';
export declare function attachMainWindowServices(mainWindow: BrowserWindow, store: Store, runtime: OrcaRuntimeService, getSelectedCodexHomePath?: () => string | null): void;
export declare function registerClipboardHandlers(): void;
export declare function registerUpdaterHandlers(_store: Store): void;
