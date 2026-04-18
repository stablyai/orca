import { app } from 'electron';
const MAC_INSTALL_READY_TIMEOUT_MS = 15000;
/** Whether Squirrel.Mac has finished downloading the update from the localhost proxy. */
let squirrelReady = false;
/** Remembers a user/app quit request that arrived before Squirrel.Mac had a
 * staged update ready to apply. Without this handoff, quitting during the
 * localhost-proxy phase exits back into the old app and the update is lost. */
let installRequestedAfterSquirrelReady = false;
/** Prevents the updater-specific before-quit guard from re-blocking the
 * quitAndInstall-triggered shutdown that is supposed to apply the update. */
let quitAndInstallInFlight = false;
/** Lets a timed-out quit attempt proceed exactly once so the app never gets
 * trapped open if Squirrel.Mac stops short of the native ready signal. */
let bypassMacInstallGuardOnce = false;
let pendingInstallTimeout = null;
function clearPendingInstallTimeout() {
    if (pendingInstallTimeout) {
        clearTimeout(pendingInstallTimeout);
        pendingInstallTimeout = null;
    }
}
export function resetMacInstallState() {
    installRequestedAfterSquirrelReady = false;
    quitAndInstallInFlight = false;
    bypassMacInstallGuardOnce = false;
    clearPendingInstallTimeout();
}
export function beginMacUpdateDownload() {
    resetMacInstallState();
    squirrelReady = false;
}
export function markMacQuitAndInstallInFlight() {
    installRequestedAfterSquirrelReady = false;
    quitAndInstallInFlight = true;
    bypassMacInstallGuardOnce = false;
    clearPendingInstallTimeout();
}
export function consumeMacInstallGuardBypass() {
    if (!bypassMacInstallGuardOnce) {
        return false;
    }
    bypassMacInstallGuardOnce = false;
    return true;
}
export function isMacQuitAndInstallInFlight() {
    return quitAndInstallInFlight;
}
export function isMacInstallerReady() {
    return squirrelReady;
}
export function isWaitingForMacInstallerReadiness(currentStatus, hasNewerDownloadedVersion) {
    if (process.platform !== 'darwin' || squirrelReady || !hasNewerDownloadedVersion) {
        return false;
    }
    // electron-updater fires 'update-downloaded' before Squirrel.Mac has staged
    // the update. Once we show 100% downloaded, treat quits as "install this as
    // soon as ShipIt is ready" instead of exiting back into the old version.
    return currentStatus.state === 'downloading' && currentStatus.percent === 100;
}
export function deferMacQuitUntilInstallerReady(currentStatus, hasNewerDownloadedVersion, getPendingInstallVersion, sendStatus) {
    if (!isWaitingForMacInstallerReadiness(currentStatus, hasNewerDownloadedVersion)) {
        return false;
    }
    installRequestedAfterSquirrelReady = true;
    sendStatus({ state: 'downloading', percent: 100, version: getPendingInstallVersion() });
    if (pendingInstallTimeout) {
        return true;
    }
    pendingInstallTimeout = setTimeout(() => {
        pendingInstallTimeout = null;
        if (!installRequestedAfterSquirrelReady || quitAndInstallInFlight) {
            return;
        }
        console.warn(`[updater] macOS installer was not ready after ${MAC_INSTALL_READY_TIMEOUT_MS}ms; allowing quit without install`);
        installRequestedAfterSquirrelReady = false;
        // This is a safety valve. The updater path should wait for ShipIt so the
        // staged update can apply, but if the native ready signal never arrives we
        // must let the app close instead of trapping the user in a blocked quit.
        bypassMacInstallGuardOnce = true;
        app.quit();
    }, MAC_INSTALL_READY_TIMEOUT_MS);
    return true;
}
export function handleMacInstallerReady(hasNewerDownloadedVersion, onReadyToInstall, onReadyToReportDownloaded) {
    squirrelReady = true;
    clearPendingInstallTimeout();
    if (installRequestedAfterSquirrelReady && hasNewerDownloadedVersion) {
        onReadyToInstall();
        return;
    }
    if (hasNewerDownloadedVersion) {
        onReadyToReportDownloaded();
    }
}
