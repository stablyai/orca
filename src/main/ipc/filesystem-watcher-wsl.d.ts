import type { WebContents } from 'electron';
import type { Event as WatcherEvent } from '@parcel/watcher';
export type WatcherSubscription = {
    unsubscribe(): Promise<void>;
};
type DebouncedBatch = {
    events: WatcherEvent[];
    timer: ReturnType<typeof setTimeout> | null;
    firstEventAt: number;
};
export type WatchedRoot = {
    subscription: WatcherSubscription;
    listeners: Map<number, WebContents>;
    batch: DebouncedBatch;
};
export type WslWatcherDeps = {
    ignoreDirs: string[];
    scheduleBatchFlush: (rootKey: string, root: WatchedRoot) => void;
    watchedRoots: Map<string, WatchedRoot>;
};
export declare function createWslWatcher(rootKey: string, worktreePath: string, deps: WslWatcherDeps): Promise<WatchedRoot>;
export {};
