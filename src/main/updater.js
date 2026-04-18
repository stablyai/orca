/* eslint-disable max-lines */
import { app, BrowserWindow, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';
import { is } from '@electron-toolkit/utils';
import { killAllPty } from './ipc/pty';
import { beginMacUpdateDownload, deferMacQuitUntilInstallerReady, markMacQuitAndInstallInFlight } from './updater-mac-install';
import { registerAutoUpdaterHandlers } from './updater-events';
import { compareVersions, isBenignCheckFailure, statusesEqual } from './updater-fallback';
import { fetchNudge, shouldApplyNudge } from './updater-nudge';
const AUTO_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AUTO_UPDATE_RETRY_INTERVAL_MS = 60 * 60 * 1000;
const NUDGE_POLL_INTERVAL_MS = 30 * 60 * 1000;
const NUDGE_ACTIVATION_COOLDOWN_MS = 5 * 60 * 1000;
const QUIT_AND_INSTALL_DELAY_MS = 100;
let mainWindowRef = null;
let currentStatus = { state: 'idle' };
let userInitiatedCheck = false;
let onBeforeQuitCleanup = null;
let autoUpdaterInitialized = false;
let availableVersion = null;
let availableReleaseUrl = null;
let pendingCheckFailureKey = null;
let pendingCheckFailurePromise = null;
let autoUpdateCheckTimer = null;
let nudgeCheckTimer = null;
let pendingQuitAndInstallTimer = null;
let persistLastUpdateCheckAt = null;
let activeUpdateNudgeId = null;
let awaitingNudgeCheckOutcome = false;
let nudgeCheckInFlight = false;
let lastNudgeCheckAt = 0;
let _getPendingUpdateNudgeId = null;
let _getDismissedUpdateNudgeId = null;
let _setPendingUpdateNudgeId = null;
let _setDismissedUpdateNudgeId = null;
// Why: guards against duplicate download() calls when both the card and
// Settings trigger a download before the first download-progress event
// flips the status to 'downloading'.
let downloadInFlight = false;
/** Guards against the macOS `activate` handler re-opening the old version
 *  while Squirrel's ShipIt is replacing the .app bundle. */
let quittingForUpdate = false;
function clearAvailableUpdateContext() {
    availableVersion = null;
    availableReleaseUrl = null;
}
function clearPendingUpdateNudge() {
    activeUpdateNudgeId = null;
    awaitingNudgeCheckOutcome = false;
    _setPendingUpdateNudgeId?.(null);
}
function getPersistedPendingUpdateNudgeId() {
    return _getPendingUpdateNudgeId?.() ?? null;
}
function decorateStatusWithActiveNudge(status) {
    // Why: only actionable/error states carry the nudge marker so the renderer
    // can tell whether a dismiss should also acknowledge the campaign. Cycle-
    // boundary states (idle, checking, not-available) never need it.
    if (!activeUpdateNudgeId) {
        return status;
    }
    if (status.state === 'idle' || status.state === 'checking' || status.state === 'not-available') {
        return status;
    }
    return { ...status, activeNudgeId: activeUpdateNudgeId };
}
function sendStatus(status) {
    if (awaitingNudgeCheckOutcome) {
        if (status.state === 'available') {
            awaitingNudgeCheckOutcome = false;
        }
        else if (status.state === 'idle' ||
            status.state === 'not-available' ||
            status.state === 'error') {
            // Why: when a nudge-triggered check finds no update (or errors out),
            // move the campaign to dismissed so it doesn't re-fire on the next
            // poll cycle. Without this, a nudge whose version range includes
            // already-up-to-date users would loop every 30 minutes, each time
            // triggering a redundant checkForUpdates() and clearing the persisted
            // dismissedUpdateVersion.
            if (activeUpdateNudgeId) {
                _setDismissedUpdateNudgeId?.(activeUpdateNudgeId);
            }
            clearPendingUpdateNudge();
        }
    }
    const decoratedStatus = decorateStatusWithActiveNudge(status);
    // Why: reset the in-flight guard when the status moves past the
    // window where duplicate download() calls are possible.
    if (decoratedStatus.state === 'downloading' ||
        decoratedStatus.state === 'error' ||
        decoratedStatus.state === 'idle') {
        downloadInFlight = false;
    }
    if (statusesEqual(currentStatus, decoratedStatus)) {
        return;
    }
    currentStatus = decoratedStatus;
    mainWindowRef?.webContents.send('updater:status', decoratedStatus);
}
function sendErrorStatus(message, userInitiated) {
    if (currentStatus.state === 'error' &&
        currentStatus.message === message &&
        currentStatus.userInitiated === userInitiated) {
        return;
    }
    sendStatus({ state: 'error', message, userInitiated });
}
function getKnownReleaseUrl() {
    return availableReleaseUrl ?? undefined;
}
function hasNewerDownloadedVersion() {
    return availableVersion !== null && compareVersions(availableVersion, app.getVersion()) > 0;
}
function getPendingInstallVersion() {
    if (availableVersion) {
        return availableVersion;
    }
    if (currentStatus.state === 'downloading' || currentStatus.state === 'downloaded') {
        return currentStatus.version;
    }
    return '';
}
function performQuitAndInstall() {
    if (pendingQuitAndInstallTimer) {
        clearTimeout(pendingQuitAndInstallTimer);
        pendingQuitAndInstallTimer = null;
    }
    markMacQuitAndInstallInFlight();
    // Set this BEFORE anything else so the `activate` handler in index.ts
    // won't re-open the old version while Squirrel's ShipIt is replacing
    // the .app bundle.  Without this guard the quit triggers window
    // destruction → BrowserWindow.getAllWindows().length === 0 → activate
    // fires → openMainWindow() resurrects the old process and ShipIt
    // either can't replace it or the user ends up on the old version.
    quittingForUpdate = true;
    killAllPty();
    onBeforeQuitCleanup?.();
    for (const win of BrowserWindow.getAllWindows()) {
        win.removeAllListeners('close');
    }
    autoUpdater.quitAndInstall(false, true);
}
async function sendCheckFailureStatus(message, userInitiated) {
    const failureKey = `${userInitiated ? 'user' : 'auto'}:${message}`;
    if (pendingCheckFailureKey === failureKey && pendingCheckFailurePromise) {
        return pendingCheckFailurePromise;
    }
    const handleFailure = async () => {
        if (isBenignCheckFailure(message)) {
            // Why: release transition failures (missing latest.yml while a new
            // release is being published) and network blips are transient.  The
            // previous approach sent 'not-available' for user-initiated checks
            // during a release transition, which falsely told the user "you're
            // on the latest version" — the toast would flash and auto-dismiss,
            // hiding the fact that a newer release is mid-publish.  Now all
            // benign failures go to 'idle' uniformly: the toast controller
            // converts a user-initiated checking→idle transition into an honest
            // "currently rolling out" message, and a background retry is
            // always scheduled so the update notification arrives once the
            // release finishes.
            console.warn('[updater] benign check failure:', message);
            clearAvailableUpdateContext();
            scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS);
            // Why: we intentionally do NOT call persistLastUpdateCheckAt here.
            // The check didn't truly complete (the manifest was unreachable due
            // to a release transition or network blip), so recording a timestamp
            // would suppress the next startup check and delay discovery of the
            // new version.
            sendStatus({ state: 'idle' });
            return;
        }
        clearAvailableUpdateContext();
        persistLastUpdateCheckAt?.(Date.now());
        if (!userInitiated) {
            scheduleAutomaticUpdateCheck(AUTO_UPDATE_RETRY_INTERVAL_MS);
        }
        sendErrorStatus(message, userInitiated);
    };
    pendingCheckFailureKey = failureKey;
    pendingCheckFailurePromise = handleFailure().finally(() => {
        if (pendingCheckFailureKey === failureKey) {
            pendingCheckFailureKey = null;
            pendingCheckFailurePromise = null;
        }
    });
    return pendingCheckFailurePromise;
}
export function getUpdateStatus() {
    return currentStatus;
}
function scheduleAutomaticUpdateCheck(delayMs) {
    if (autoUpdateCheckTimer) {
        clearTimeout(autoUpdateCheckTimer);
    }
    autoUpdateCheckTimer = setTimeout(() => {
        // Why: Orca is often left running for days. A one-shot startup check means
        // users can miss fresh releases entirely, so we always keep the next
        // background attempt scheduled in the main process instead of tying checks
        // to relaunches or renderer lifetime.
        runBackgroundUpdateCheck();
    }, delayMs);
}
function recordCompletedUpdateCheck() {
    persistLastUpdateCheckAt?.(Date.now());
}
function runBackgroundUpdateCheck(nudgeId = getPersistedPendingUpdateNudgeId()) {
    if (!app.isPackaged || is.dev) {
        sendStatus({ state: 'not-available' });
        return;
    }
    // Why: scope the nudge marker to the updater cycle being launched right now.
    // Setting it here, before any updater events or rejected promises can arrive,
    // prevents later ordinary checks from inheriting an older campaign id. Use
    // the persisted pending id for ordinary background checks so a nudge-driven
    // card can still be dismissed correctly after relaunch or a later 24h check.
    activeUpdateNudgeId = nudgeId;
    // Don't send 'checking' here — the 'checking-for-update' event handler does it,
    // and sending it from both places causes duplicate notifications (issue #35).
    autoUpdater.checkForUpdates().catch((err) => {
        void sendCheckFailureStatus(String(err?.message ?? err));
    });
}
export function checkForUpdates() {
    runBackgroundUpdateCheck();
}
/** Menu-triggered check — delegates feedback to renderer toasts via userInitiated flag */
export function checkForUpdatesFromMenu() {
    if (!app.isPackaged || is.dev) {
        sendStatus({ state: 'not-available', userInitiated: true });
        return;
    }
    userInitiatedCheck = true;
    // Why: a manual check is independent of any active nudge campaign. Reset the
    // nudge marker so the resulting status is not decorated with activeNudgeId,
    // which would cause a later dismiss to consume the campaign by accident.
    activeUpdateNudgeId = null;
    // Don't send 'checking' here — the 'checking-for-update' event handler does it,
    // and sending it from both places causes duplicate notifications (issue #35).
    autoUpdater.checkForUpdates().catch((err) => {
        userInitiatedCheck = false;
        void sendCheckFailureStatus(String(err?.message ?? err), true);
    });
}
export function isQuittingForUpdate() {
    return quittingForUpdate;
}
export function quitAndInstall() {
    if (pendingQuitAndInstallTimer) {
        return;
    }
    if (deferMacQuitUntilInstallerReady(currentStatus, hasNewerDownloadedVersion(), getPendingInstallVersion, sendStatus)) {
        return;
    }
    // Why: every renderer entrypoint reaches this IPC handler from an in-flight
    // click or toast callback. Deferring the actual quit here gives the renderer
    // a moment to flush dismissals/state updates before windows start closing,
    // and centralizing it avoids drift between the toast flow and settings UI.
    pendingQuitAndInstallTimer = setTimeout(() => {
        performQuitAndInstall();
    }, QUIT_AND_INSTALL_DELAY_MS);
}
async function checkForUpdateNudge() {
    if (!app.isPackaged || is.dev) {
        return;
    }
    if (nudgeCheckInFlight) {
        return;
    }
    const now = Date.now();
    if (now - lastNudgeCheckAt < NUDGE_ACTIVATION_COOLDOWN_MS) {
        return;
    }
    lastNudgeCheckAt = now;
    nudgeCheckInFlight = true;
    try {
        const nudge = await fetchNudge();
        if (!nudge) {
            return;
        }
        if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
            return;
        }
        const appVersion = app.getVersion();
        const pendingUpdateNudgeId = _getPendingUpdateNudgeId?.() ?? null;
        const dismissedUpdateNudgeId = _getDismissedUpdateNudgeId?.() ?? null;
        if (shouldApplyNudge({
            nudge,
            appVersion,
            pendingUpdateNudgeId,
            dismissedUpdateNudgeId
        })) {
            awaitingNudgeCheckOutcome = true;
            _setPendingUpdateNudgeId?.(nudge.id);
            mainWindowRef?.webContents.send('updater:clearDismissal');
            runBackgroundUpdateCheck(nudge.id);
        }
    }
    finally {
        nudgeCheckInFlight = false;
    }
}
function scheduleUpdateNudgeCheck() {
    if (nudgeCheckTimer) {
        clearTimeout(nudgeCheckTimer);
    }
    nudgeCheckTimer = setTimeout(() => {
        void checkForUpdateNudge();
        scheduleUpdateNudgeCheck();
    }, NUDGE_POLL_INTERVAL_MS);
}
export function dismissNudge() {
    const pendingId = activeUpdateNudgeId ?? _getPendingUpdateNudgeId?.() ?? null;
    if (pendingId) {
        _setDismissedUpdateNudgeId?.(pendingId);
        clearPendingUpdateNudge();
    }
}
export function setupAutoUpdater(mainWindow, opts) {
    mainWindowRef = mainWindow;
    onBeforeQuitCleanup = opts?.onBeforeQuit ?? null;
    persistLastUpdateCheckAt = opts?.setLastUpdateCheckAt ?? null;
    _getPendingUpdateNudgeId = opts?.getPendingUpdateNudgeId ?? null;
    _getDismissedUpdateNudgeId = opts?.getDismissedUpdateNudgeId ?? null;
    _setPendingUpdateNudgeId = opts?.setPendingUpdateNudgeId ?? null;
    _setDismissedUpdateNudgeId = opts?.setDismissedUpdateNudgeId ?? null;
    if (!app.isPackaged && !is.dev) {
        return;
    }
    if (is.dev) {
        return;
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    // Why: no Windows Authenticode certificate exists for this project.
    // electron-builder embeds the code-signing publisherName into the app's
    // bundled app-update.yml at build time. Versions that were incorrectly
    // signed with the macOS Apple Developer ID cert (issue #631) baked in a
    // publisherName whose chain Windows cannot validate, and even after the
    // CI fix the installed app's app-update.yml still contains the stale
    // publisherName. Skip Windows code signing verification — update
    // integrity is still guaranteed by the SHA-512 hash check in latest.yml.
    //
    // TODO: remove this override once a Windows Authenticode certificate is
    // purchased and WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD are added to CI.
    // At that point electron-builder will embed the correct publisherName
    // and the default verification should be re-enabled.
    if (process.platform === 'win32') {
        ;
        autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
    }
    // Use the generic provider with GitHub's /releases/latest/download/ URL so
    // electron-updater always fetches the manifest (latest-mac.yml, latest.yml,
    // latest-linux.yml) from the latest non-prerelease release. This sidesteps
    // the broken /releases/latest API endpoint (returns 406) and automatically
    // excludes RC/prerelease versions without client-side filtering.
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/latest/download'
    });
    if (autoUpdaterInitialized) {
        return;
    }
    autoUpdaterInitialized = true;
    registerAutoUpdaterHandlers({
        clearAvailableUpdateContext,
        getCurrentStatus: () => currentStatus,
        getKnownReleaseUrl,
        getPendingInstallVersion,
        getUserInitiatedCheck: () => userInitiatedCheck,
        hasNewerDownloadedVersion,
        performQuitAndInstall,
        sendCheckFailureStatus,
        sendErrorStatus,
        recordCompletedUpdateCheck,
        sendStatus,
        scheduleAutomaticUpdateCheck,
        setAvailableReleaseUrl: (releaseUrl) => {
            availableReleaseUrl = releaseUrl;
        },
        setAvailableVersion: (version) => {
            availableVersion = version;
        },
        setUserInitiatedCheck: (value) => {
            userInitiatedCheck = value;
        }
    });
    void checkForUpdateNudge();
    scheduleUpdateNudgeCheck();
    powerMonitor.on('resume', () => {
        void checkForUpdateNudge();
    });
    app.on('browser-window-focus', () => {
        void checkForUpdateNudge();
    });
    const lastUpdateCheckAt = opts?.getLastUpdateCheckAt?.() ?? null;
    const msSinceLastCheck = lastUpdateCheckAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastUpdateCheckAt;
    if (msSinceLastCheck >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
        runBackgroundUpdateCheck();
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS);
    }
    else {
        scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS - msSinceLastCheck);
    }
}
export function downloadUpdate() {
    if (currentStatus.state !== 'available' || downloadInFlight) {
        return;
    }
    downloadInFlight = true;
    beginMacUpdateDownload();
    autoUpdater.downloadUpdate().catch((err) => {
        downloadInFlight = false;
        sendErrorStatus(String(err?.message ?? err));
    });
}
