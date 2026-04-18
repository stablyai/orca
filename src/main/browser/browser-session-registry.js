import { app, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORCA_BROWSER_PARTITION } from '../../shared/constants';
import { browserManager } from './browser-manager';
// Why: the registry is the single source of truth for which Electron partitions
// are valid. will-attach-webview consults it to decide whether a guest's
// requested partition is allowed. This prevents a compromised renderer from
// smuggling an arbitrary partition string into a guest surface.
class BrowserSessionRegistry {
    profiles = new Map();
    constructor() {
        const persisted = this.loadPersistedSource();
        this.profiles.set('default', {
            id: 'default',
            scope: 'default',
            partition: ORCA_BROWSER_PARTITION,
            label: 'Default',
            source: persisted
        });
    }
    // Why: the default profile's source metadata (what browser was imported,
    // when) must survive app restarts so the Settings UI can show the import
    // status. Cookies themselves persist in the Electron partition's SQLite DB,
    // but the registry is in-memory only.
    get metadataPath() {
        return join(app.getPath('userData'), 'browser-session-meta.json');
    }
    loadPersistedSource() {
        return this.loadPersistedMeta().defaultSource;
    }
    persistMeta(updates) {
        try {
            const existing = this.loadPersistedMeta();
            writeFileSync(this.metadataPath, JSON.stringify({ ...existing, ...updates }));
        }
        catch {
            // best-effort
        }
    }
    persistSource(source, userAgent) {
        this.persistMeta({
            defaultSource: source,
            ...(userAgent !== undefined ? { userAgent } : {})
        });
    }
    loadPersistedMeta() {
        try {
            const raw = readFileSync(this.metadataPath, 'utf-8');
            const data = JSON.parse(raw);
            return {
                defaultSource: data?.defaultSource ?? null,
                userAgent: data?.userAgent ?? null,
                pendingCookieDbPath: data?.pendingCookieDbPath ?? null
            };
        }
        catch {
            return { defaultSource: null, userAgent: null, pendingCookieDbPath: null };
        }
    }
    // Why: the User-Agent must be set on the session BEFORE any webview loads,
    // otherwise the first request uses Electron's default UA and the server may
    // invalidate the imported session cookies.
    //
    // Why this also refreshes defaultSource: the singleton constructor runs at
    // module-import time, which may be before app.isReady(). app.getPath('userData')
    // is not guaranteed before ready, so the constructor's loadPersistedSource()
    // silently returns null. Re-reading here (called from registerCoreHandlers,
    // after app is ready) ensures the default profile's source is populated.
    restorePersistedUserAgent() {
        const meta = this.loadPersistedMeta();
        if (meta.userAgent) {
            const sess = session.fromPartition(ORCA_BROWSER_PARTITION);
            sess.setUserAgent(meta.userAgent);
            this.setupClientHintsOverride(sess, meta.userAgent);
        }
        if (meta.defaultSource) {
            const current = this.profiles.get('default');
            if (current && current.source === null) {
                this.profiles.set('default', { ...current, source: meta.defaultSource });
            }
        }
    }
    // Why: Electron's actual Chromium version (e.g. 134) differs from the source
    // browser's version (e.g. Edge 147). The sec-ch-ua Client Hints headers
    // reveal the real version, creating a mismatch that Google's anti-fraud
    // detection flags as CookieMismatch on accounts.google.com. Override Client
    // Hints on outgoing requests to match the source browser's UA.
    setupClientHintsOverride(sess, ua) {
        const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
        if (!chromeMatch) {
            return;
        }
        const fullChromeVersion = chromeMatch[1];
        const majorVersion = fullChromeVersion.split('.')[0];
        let brand = 'Google Chrome';
        let brandFullVersion = fullChromeVersion;
        const edgeMatch = ua.match(/Edg\/([\d.]+)/);
        if (edgeMatch) {
            brand = 'Microsoft Edge';
            brandFullVersion = edgeMatch[1];
        }
        const brandMajor = brandFullVersion.split('.')[0];
        const secChUa = `"${brand}";v="${brandMajor}", "Chromium";v="${majorVersion}", "Not/A)Brand";v="24"`;
        const secChUaFull = `"${brand}";v="${brandFullVersion}", "Chromium";v="${fullChromeVersion}", "Not/A)Brand";v="24.0.0.0"`;
        sess.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (details, callback) => {
            const headers = details.requestHeaders;
            for (const key of Object.keys(headers)) {
                const lower = key.toLowerCase();
                if (lower === 'sec-ch-ua') {
                    headers[key] = secChUa;
                }
                else if (lower === 'sec-ch-ua-full-version-list') {
                    headers[key] = secChUaFull;
                }
            }
            callback({ requestHeaders: headers });
        });
    }
    // Why: the import writes cookies to a staging DB because CookieMonster holds
    // the live DB's data in memory and would overwrite our changes on its next
    // flush. This method MUST run before any session.fromPartition() call so
    // CookieMonster reads the staged cookies instead of the stale live DB.
    applyPendingCookieImport() {
        try {
            const meta = this.loadPersistedMeta();
            if (!meta.pendingCookieDbPath) {
                return;
            }
            if (!existsSync(meta.pendingCookieDbPath)) {
                this.persistMeta({ pendingCookieDbPath: null });
                return;
            }
            const partitionName = ORCA_BROWSER_PARTITION.replace('persist:', '');
            const liveCookiesPath = join(app.getPath('userData'), 'Partitions', partitionName, 'Cookies');
            copyFileSync(meta.pendingCookieDbPath, liveCookiesPath);
            // Why: SQLite WAL mode stores uncommitted data in sidecar files.
            // Stale WAL/SHM from a previous session could corrupt CookieMonster's
            // read of the freshly swapped DB.
            for (const suffix of ['-wal', '-shm']) {
                try {
                    unlinkSync(liveCookiesPath + suffix);
                }
                catch {
                    /* may not exist */
                }
                const stagingSidecar = meta.pendingCookieDbPath + suffix;
                if (existsSync(stagingSidecar)) {
                    try {
                        copyFileSync(stagingSidecar, liveCookiesPath + suffix);
                    }
                    catch {
                        /* best-effort */
                    }
                }
            }
            for (const ext of ['', '-wal', '-shm']) {
                try {
                    unlinkSync(`${meta.pendingCookieDbPath}${ext}`);
                }
                catch {
                    /* best-effort */
                }
            }
            this.persistMeta({ pendingCookieDbPath: null });
        }
        catch {
            // best-effort — if this fails, CookieMonster loads the old DB
        }
    }
    setPendingCookieImport(stagingDbPath) {
        this.persistMeta({ pendingCookieDbPath: stagingDbPath });
    }
    persistUserAgent(userAgent) {
        const defaultProfile = this.profiles.get('default');
        this.persistSource(defaultProfile?.source ?? null, userAgent);
    }
    getDefaultProfile() {
        return this.profiles.get('default');
    }
    getProfile(profileId) {
        return this.profiles.get(profileId) ?? null;
    }
    listProfiles() {
        return [...this.profiles.values()];
    }
    isAllowedPartition(partition) {
        if (partition === ORCA_BROWSER_PARTITION) {
            return true;
        }
        return [...this.profiles.values()].some((p) => p.partition === partition);
    }
    resolvePartition(profileId) {
        if (!profileId) {
            return ORCA_BROWSER_PARTITION;
        }
        return this.profiles.get(profileId)?.partition ?? ORCA_BROWSER_PARTITION;
    }
    createProfile(scope, label) {
        const id = randomUUID();
        // Why: partition names are deterministic from the profile id so main can
        // reconstruct the allowlist on restart from persisted profile metadata
        // without needing a separate partition→profile mapping.
        const partition = scope === 'default' ? ORCA_BROWSER_PARTITION : `persist:orca-browser-session-${id}`;
        const profile = {
            id,
            scope,
            partition,
            label,
            source: null
        };
        this.profiles.set(id, profile);
        if (partition !== ORCA_BROWSER_PARTITION) {
            this.setupSessionPolicies(partition);
        }
        return profile;
    }
    updateProfileSource(profileId, source) {
        const profile = this.profiles.get(profileId);
        if (!profile) {
            return null;
        }
        const updated = { ...profile, source };
        this.profiles.set(profileId, updated);
        if (profileId === 'default') {
            this.persistSource(source);
        }
        return updated;
    }
    async deleteProfile(profileId) {
        const profile = this.profiles.get(profileId);
        if (!profile || profile.scope === 'default') {
            return false;
        }
        this.profiles.delete(profileId);
        // Why: clearing the partition's storage prevents orphaned cookies/cache from
        // lingering after the user deletes an imported or isolated session profile.
        try {
            const sess = session.fromPartition(profile.partition);
            await sess.clearStorageData();
            await sess.clearCache();
        }
        catch {
            // Why: partition cleanup is best-effort. The profile is already removed
            // from the registry so it won't be allowed by will-attach-webview.
        }
        return true;
    }
    // Why: clearing cookies from the default partition lets users undo a cookie
    // import without deleting the default profile itself.
    async clearDefaultSessionCookies() {
        try {
            // Why: persist metadata BEFORE clearing storage so that if the app quits
            // mid-clear, the next launch won't show a stale "imported from X" badge
            // for cookies that were partially or fully removed.
            const defaultProfile = this.profiles.get('default');
            if (defaultProfile) {
                this.profiles.set('default', { ...defaultProfile, source: null });
            }
            this.persistMeta({ defaultSource: null, userAgent: null, pendingCookieDbPath: null });
            const sess = session.fromPartition(ORCA_BROWSER_PARTITION);
            await sess.clearStorageData({ storages: ['cookies'] });
            return true;
        }
        catch {
            return false;
        }
    }
    // Why: on startup, main must reconstruct the set of valid partitions from
    // persisted session profiles so restored webviews are not denied by
    // will-attach-webview before the renderer mounts them.
    hydrateFromPersisted(profiles) {
        for (const profile of profiles) {
            if (profile.id === 'default') {
                continue;
            }
            this.profiles.set(profile.id, profile);
            if (profile.partition !== ORCA_BROWSER_PARTITION) {
                this.setupSessionPolicies(profile.partition);
            }
        }
    }
    // Why: each non-default partition needs the same deny-by-default permission
    // and download policies as the shared partition. Without this, newly created
    // session partitions would silently allow permissions and downloads that the
    // shared partition correctly denies.
    configuredPartitions = new Set();
    setupSessionPolicies(partition) {
        if (this.configuredPartitions.has(partition)) {
            return;
        }
        this.configuredPartitions.add(partition);
        const sess = session.fromPartition(partition);
        sess.setPermissionRequestHandler((webContents, permission, callback) => {
            const allowed = permission === 'fullscreen';
            if (!allowed) {
                browserManager.notifyPermissionDenied({
                    guestWebContentsId: webContents.id,
                    permission,
                    rawUrl: webContents.getURL()
                });
            }
            callback(allowed);
        });
        sess.setPermissionCheckHandler((_webContents, permission) => {
            return permission === 'fullscreen';
        });
        sess.setDisplayMediaRequestHandler((_request, callback) => {
            callback({ video: undefined, audio: undefined });
        });
        sess.on('will-download', (_event, item, webContents) => {
            browserManager.handleGuestWillDownload({ guestWebContentsId: webContents.id, item });
        });
    }
}
export const browserSessionRegistry = new BrowserSessionRegistry();
