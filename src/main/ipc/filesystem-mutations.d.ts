import type { Store } from '../persistence';
/**
 * IPC handlers for file/folder creation and renaming.
 * Deletion is handled separately via `fs:deletePath` (shell.trashItem).
 */
export declare function registerFilesystemMutationHandlers(store: Store): void;
export type ImportItemResult = {
    sourcePath: string;
    status: 'imported';
    destPath: string;
    kind: 'file' | 'directory';
    renamed: boolean;
} | {
    sourcePath: string;
    status: 'skipped';
    reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported';
} | {
    sourcePath: string;
    status: 'failed';
    reason: string;
};
