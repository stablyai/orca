/* eslint-disable max-lines -- Why: persistence keeps schema defaults, migration,
load/save, and flush logic in one file so the full storage contract is reviewable
as a unit instead of being scattered across modules. */
import { app } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { writeFile, rename, mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { isFolderRepo } from '../shared/repo-kind';
import { getGitUsername } from './git/repo';
import { getDefaultPersistedState, getDefaultNotificationSettings, getDefaultUIState, getDefaultRepoHookSettings, getDefaultWorkspaceSession } from '../shared/constants';
// Why: the data-file path must not be a module-level constant. Module-level
// code runs at import time — before configureDevUserDataPath() redirects the
// userData path in index.ts — so a constant would capture the default (non-dev)
// path, causing dev and production instances to share the same file and silently
// overwrite each other.
//
// It also must not be resolved lazily on every call, because app.setName('Orca')
// runs before the Store constructor and would change the resolved path from
// lowercase 'orca' to uppercase 'Orca'. On case-sensitive filesystems (Linux)
// this would look in the wrong directory and lose existing user data.
//
// Solution: index.ts calls initDataPath() right after configureDevUserDataPath()
// but before app.setName(), capturing the correct path at the right moment.
let _dataFile = null;
export function initDataPath() {
    _dataFile = join(app.getPath('userData'), 'orca-data.json');
}
function getDataFile() {
    if (!_dataFile) {
        // Safety fallback — should not be hit in normal startup.
        _dataFile = join(app.getPath('userData'), 'orca-data.json');
    }
    return _dataFile;
}
function normalizeSortBy(sortBy) {
    if (sortBy === 'smart' || sortBy === 'recent' || sortBy === 'repo' || sortBy === 'name') {
        return sortBy;
    }
    return getDefaultUIState().sortBy;
}
// Why: old persisted targets predate configHost. Default to label-based lookup
// so imported SSH aliases keep resolving through ssh -G after upgrade.
function normalizeSshTarget(t) {
    return { ...t, configHost: t.configHost ?? t.label ?? t.host };
}
export class Store {
    state;
    writeTimer = null;
    pendingWrite = null;
    writeGeneration = 0;
    gitUsernameCache = new Map();
    constructor() {
        this.state = this.load();
    }
    load() {
        try {
            const dataFile = getDataFile();
            if (existsSync(dataFile)) {
                const raw = readFileSync(dataFile, 'utf-8');
                const parsed = JSON.parse(raw);
                // Merge with defaults in case new fields were added
                const defaults = getDefaultPersistedState(homedir());
                return {
                    ...defaults,
                    ...parsed,
                    settings: {
                        ...defaults.settings,
                        ...parsed.settings,
                        notifications: {
                            ...getDefaultNotificationSettings(),
                            ...parsed.settings?.notifications
                        }
                    },
                    // Why: 'recent' used to mean the weighted smart sort. One-shot
                    // migration moves it to 'smart'; the flag prevents re-firing after
                    // a user intentionally selects the new creation-time 'recent' sort.
                    ui: (() => {
                        const sort = normalizeSortBy(parsed.ui?.sortBy);
                        const migrate = !parsed.ui?._sortBySmartMigrated && sort === 'recent';
                        return {
                            ...defaults.ui,
                            ...parsed.ui,
                            sortBy: migrate ? 'smart' : sort,
                            _sortBySmartMigrated: true
                        };
                    })(),
                    workspaceSession: { ...defaults.workspaceSession, ...parsed.workspaceSession },
                    sshTargets: (parsed.sshTargets ?? []).map(normalizeSshTarget)
                };
            }
        }
        catch (err) {
            console.error('[persistence] Failed to load state, using defaults:', err);
        }
        return getDefaultPersistedState(homedir());
    }
    scheduleSave() {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
        }
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            this.pendingWrite = this.writeToDiskAsync()
                .catch((err) => {
                console.error('[persistence] Failed to write state:', err);
            })
                .finally(() => {
                this.pendingWrite = null;
            });
        }, 300);
    }
    /** Wait for any in-flight async disk write to complete. Used in tests. */
    async waitForPendingWrite() {
        if (this.pendingWrite) {
            await this.pendingWrite;
        }
    }
    // Why: async writes avoid blocking the main Electron thread on every
    // debounced save (every 300ms during active use).
    async writeToDiskAsync() {
        const gen = this.writeGeneration;
        const dataFile = getDataFile();
        const dir = dirname(dataFile);
        await mkdir(dir, { recursive: true }).catch(() => { });
        const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        await writeFile(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8');
        // Why: if flush() ran while this async write was in-flight, it bumped
        // writeGeneration and already wrote the latest state synchronously.
        // Renaming this stale tmp file would overwrite the fresh data.
        if (this.writeGeneration !== gen) {
            await rm(tmpFile).catch(() => { });
            return;
        }
        await rename(tmpFile, dataFile);
    }
    // Why: synchronous variant kept only for flush() at shutdown, where the
    // process may exit before an async write completes.
    writeToDiskSync() {
        const dataFile = getDataFile();
        const dir = dirname(dataFile);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        const tmpFile = `${dataFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
        writeFileSync(tmpFile, JSON.stringify(this.state, null, 2), 'utf-8');
        renameSync(tmpFile, dataFile);
    }
    // ── Repos ──────────────────────────────────────────────────────────
    getRepos() {
        return this.state.repos.map((repo) => this.hydrateRepo(repo));
    }
    getRepo(id) {
        const repo = this.state.repos.find((r) => r.id === id);
        return repo ? this.hydrateRepo(repo) : undefined;
    }
    addRepo(repo) {
        this.state.repos.push(repo);
        this.scheduleSave();
    }
    removeRepo(id) {
        this.state.repos = this.state.repos.filter((r) => r.id !== id);
        // Clean up worktree meta for this repo
        const prefix = `${id}::`;
        for (const key of Object.keys(this.state.worktreeMeta)) {
            if (key.startsWith(prefix)) {
                delete this.state.worktreeMeta[key];
            }
        }
        this.scheduleSave();
    }
    updateRepo(id, updates) {
        const repo = this.state.repos.find((r) => r.id === id);
        if (!repo) {
            return null;
        }
        Object.assign(repo, updates);
        this.scheduleSave();
        return this.hydrateRepo(repo);
    }
    hydrateRepo(repo) {
        const gitUsername = isFolderRepo(repo)
            ? ''
            : (this.gitUsernameCache.get(repo.path) ??
                (() => {
                    const username = getGitUsername(repo.path);
                    this.gitUsernameCache.set(repo.path, username);
                    return username;
                })());
        return {
            ...repo,
            kind: isFolderRepo(repo) ? 'folder' : 'git',
            gitUsername,
            hookSettings: {
                ...getDefaultRepoHookSettings(),
                ...repo.hookSettings,
                scripts: {
                    ...getDefaultRepoHookSettings().scripts,
                    ...repo.hookSettings?.scripts
                }
            }
        };
    }
    // ── Worktree Meta ──────────────────────────────────────────────────
    getWorktreeMeta(worktreeId) {
        return this.state.worktreeMeta[worktreeId];
    }
    getAllWorktreeMeta() {
        return this.state.worktreeMeta;
    }
    setWorktreeMeta(worktreeId, meta) {
        const existing = this.state.worktreeMeta[worktreeId] || getDefaultWorktreeMeta();
        const updated = { ...existing, ...meta };
        this.state.worktreeMeta[worktreeId] = updated;
        this.scheduleSave();
        return updated;
    }
    removeWorktreeMeta(worktreeId) {
        delete this.state.worktreeMeta[worktreeId];
        this.scheduleSave();
    }
    // ── Settings ───────────────────────────────────────────────────────
    getSettings() {
        return this.state.settings;
    }
    updateSettings(updates) {
        this.state.settings = {
            ...this.state.settings,
            ...updates,
            notifications: {
                ...this.state.settings.notifications,
                ...updates.notifications
            }
        };
        this.scheduleSave();
        return this.state.settings;
    }
    // ── UI State ───────────────────────────────────────────────────────
    getUI() {
        return {
            ...getDefaultUIState(),
            ...this.state.ui,
            sortBy: normalizeSortBy(this.state.ui?.sortBy)
        };
    }
    updateUI(updates) {
        this.state.ui = {
            ...this.state.ui,
            ...updates,
            sortBy: updates.sortBy
                ? normalizeSortBy(updates.sortBy)
                : normalizeSortBy(this.state.ui?.sortBy)
        };
        this.scheduleSave();
    }
    // ── GitHub Cache ──────────────────────────────────────────────────
    getGitHubCache() {
        return this.state.githubCache;
    }
    setGitHubCache(cache) {
        this.state.githubCache = cache;
        this.scheduleSave();
    }
    // ── Workspace Session ─────────────────────────────────────────────
    getWorkspaceSession() {
        return this.state.workspaceSession ?? getDefaultWorkspaceSession();
    }
    setWorkspaceSession(session) {
        this.state.workspaceSession = session;
        this.scheduleSave();
    }
    // ── SSH Targets ────────────────────────────────────────────────────
    getSshTargets() {
        return (this.state.sshTargets ?? []).map(normalizeSshTarget);
    }
    getSshTarget(id) {
        const target = this.state.sshTargets?.find((t) => t.id === id);
        return target ? normalizeSshTarget(target) : undefined;
    }
    addSshTarget(target) {
        this.state.sshTargets ??= [];
        this.state.sshTargets.push(normalizeSshTarget(target));
        this.scheduleSave();
    }
    updateSshTarget(id, updates) {
        const target = this.state.sshTargets?.find((t) => t.id === id);
        if (!target) {
            return null;
        }
        Object.assign(target, updates, normalizeSshTarget({ ...target, ...updates }));
        this.scheduleSave();
        return { ...target };
    }
    removeSshTarget(id) {
        if (!this.state.sshTargets) {
            return;
        }
        this.state.sshTargets = this.state.sshTargets.filter((t) => t.id !== id);
        this.scheduleSave();
    }
    // ── Flush (for shutdown) ───────────────────────────────────────────
    flush() {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }
        // Why: bump writeGeneration so any in-flight async writeToDiskAsync skips
        // its rename, preventing a stale snapshot from overwriting this sync write.
        this.writeGeneration++;
        this.pendingWrite = null;
        try {
            this.writeToDiskSync();
        }
        catch (err) {
            console.error('[persistence] Failed to flush state:', err);
        }
    }
}
function getDefaultWorktreeMeta() {
    return {
        displayName: '',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: Date.now(),
        lastActivityAt: 0
    };
}
