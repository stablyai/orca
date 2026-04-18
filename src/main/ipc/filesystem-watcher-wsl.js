/**
 * Polling-based file watcher for WSL paths.
 *
 * Why: @parcel/watcher uses ReadDirectoryChangesW which doesn't work across
 * the WSL network filesystem boundary (\\wsl.localhost\…).  Instead of
 * requiring the user to install extra tools inside WSL, we poll the
 * directory tree via Node's fs.readdir (which works on UNC paths) and diff
 * against a snapshot to detect changes.  A 2 s poll interval is a good
 * balance between responsiveness and CPU cost — nobody stares at the file
 * explorer waiting for instant refresh.
 */
import { readdir } from 'fs/promises';
import * as path from 'path';
const POLL_INTERVAL_MS = 2000;
async function readDirSafe(dirPath) {
    try {
        const entries = await readdir(dirPath);
        return entries;
    }
    catch {
        return [];
    }
}
function shouldIgnore(name, ignoreDirs) {
    return ignoreDirs.includes(name);
}
/**
 * Take a snapshot of the root directory and one level of subdirectories.
 * Returns a map of dirPath → set of entry names.
 */
async function takeSnapshot(rootPath, ignoreDirs) {
    const snapshot = new Map();
    const rootEntries = await readDirSafe(rootPath);
    const filtered = rootEntries.filter((name) => !shouldIgnore(name, ignoreDirs));
    snapshot.set(rootPath, new Set(filtered));
    // Why: poll one level of subdirectories so changes inside immediate
    // children are detected (e.g. editing src/foo.ts).  Going deeper
    // would be too expensive for large repos.  The renderer requests
    // deeper directories explicitly via readDir when the user expands.
    await Promise.all(filtered.map(async (name) => {
        const childPath = path.join(rootPath, name);
        try {
            const childEntries = await readDirSafe(childPath);
            const childFiltered = childEntries.filter((n) => !shouldIgnore(n, ignoreDirs));
            snapshot.set(childPath, new Set(childFiltered));
        }
        catch {
            // Not a directory or inaccessible — skip
        }
    }));
    return snapshot;
}
/**
 * Diff two snapshots and return synthetic watcher events.
 */
function diffSnapshots(prev, next) {
    const events = [];
    for (const [dirPath, nextEntries] of next) {
        const prevEntries = prev.get(dirPath);
        if (!prevEntries) {
            // New directory appeared — emit create for all entries
            for (const name of nextEntries) {
                events.push({ type: 'create', path: path.join(dirPath, name) });
            }
            continue;
        }
        // Check for new entries (create)
        for (const name of nextEntries) {
            if (!prevEntries.has(name)) {
                events.push({ type: 'create', path: path.join(dirPath, name) });
            }
        }
        // Check for removed entries (delete)
        for (const name of prevEntries) {
            if (!nextEntries.has(name)) {
                events.push({ type: 'delete', path: path.join(dirPath, name) });
            }
        }
    }
    // Check for directories that disappeared entirely
    for (const [dirPath] of prev) {
        if (!next.has(dirPath)) {
            events.push({ type: 'delete', path: dirPath });
        }
    }
    return events;
}
export async function createWslWatcher(rootKey, worktreePath, deps) {
    const root = {
        subscription: null,
        listeners: new Map(),
        batch: { events: [], timer: null, firstEventAt: 0 }
    };
    // Take initial snapshot
    let prevSnapshot = await takeSnapshot(worktreePath, deps.ignoreDirs);
    const intervalId = setInterval(async () => {
        try {
            const nextSnapshot = await takeSnapshot(worktreePath, deps.ignoreDirs);
            const events = diffSnapshots(prevSnapshot, nextSnapshot);
            prevSnapshot = nextSnapshot;
            if (events.length > 0) {
                root.batch.events.push(...events);
                deps.scheduleBatchFlush(rootKey, root);
            }
        }
        catch {
            // Why: if the WSL filesystem becomes temporarily unavailable
            // (e.g. WSL distro shuts down), skip this poll cycle rather
            // than crashing.  The next cycle will retry.
        }
    }, POLL_INTERVAL_MS);
    root.subscription = {
        unsubscribe: async () => {
            clearInterval(intervalId);
        }
    };
    return root;
}
