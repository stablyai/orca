import { net } from 'electron';
import { compareVersions, isValidVersion } from './updater-fallback';
export async function fetchNudge() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await net.fetch('https://onorca.dev/whats-new/nudge.json', {
            signal: controller.signal
        });
        if (!res.ok) {
            return null;
        }
        const json = await res.json();
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
            return null;
        }
        const { id, minVersion, maxVersion } = json;
        if (typeof id !== 'string' || !id.trim()) {
            return null;
        }
        if (minVersion === undefined && maxVersion === undefined) {
            return null;
        }
        if (minVersion !== undefined && typeof minVersion !== 'string') {
            return null;
        }
        if (maxVersion !== undefined && typeof maxVersion !== 'string') {
            return null;
        }
        if (minVersion !== undefined && !isValidVersion(minVersion)) {
            return null;
        }
        if (maxVersion !== undefined && !isValidVersion(maxVersion)) {
            return null;
        }
        if (minVersion !== undefined &&
            maxVersion !== undefined &&
            compareVersions(minVersion, maxVersion) > 0) {
            return null;
        }
        return {
            id: id.trim(),
            minVersion,
            maxVersion
        };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}
export function versionMatchesRange(appVersion, range) {
    if (range.minVersion !== undefined && compareVersions(appVersion, range.minVersion) < 0) {
        return false;
    }
    if (range.maxVersion !== undefined && compareVersions(appVersion, range.maxVersion) > 0) {
        return false;
    }
    return true;
}
export function shouldApplyNudge(args) {
    const { nudge, appVersion, pendingUpdateNudgeId, dismissedUpdateNudgeId } = args;
    if (nudge.id === pendingUpdateNudgeId || nudge.id === dismissedUpdateNudgeId) {
        return false;
    }
    return versionMatchesRange(appVersion, nudge);
}
