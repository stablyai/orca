import { registerCliHandlers } from './cli';
import { registerPreflightHandlers } from './preflight';
import { registerFilesystemHandlers } from './filesystem';
import { registerFilesystemWatcherHandlers } from './filesystem-watcher';
import { registerClaudeUsageHandlers } from './claude-usage';
import { registerCodexUsageHandlers } from './codex-usage';
import { registerGitHubHandlers } from './github';
import { registerStatsHandlers } from './stats';
import { registerRateLimitHandlers } from './rate-limits';
import { registerRuntimeHandlers } from './runtime';
import { registerNotificationHandlers } from './notifications';
import { setTrustedBrowserRendererWebContentsId } from './browser';
import { registerSessionHandlers } from './session';
import { registerSettingsHandlers } from './settings';
import { registerBrowserHandlers } from './browser';
import { browserSessionRegistry } from '../browser/browser-session-registry';
import { registerShellHandlers } from './shell';
import { registerUIHandlers } from './ui';
import { registerCodexAccountHandlers } from './codex-accounts';
import { warmSystemFontFamilies } from '../system-fonts';
import { registerClipboardHandlers, registerUpdaterHandlers } from '../window/attach-main-window-services';
let registered = false;
export function registerCoreHandlers(store, runtime, stats, claudeUsage, codexUsage, codexAccounts, rateLimits, mainWindowWebContentsId = null) {
    // Why: on macOS the app can stay alive after all windows close, then
    // openMainWindow() is called again on 'activate'. ipcMain.handle() throws
    // if a channel is registered twice, so we guard to register only once and
    // just update the per-window web-contents ID on subsequent calls.
    setTrustedBrowserRendererWebContentsId(mainWindowWebContentsId);
    if (registered) {
        return;
    }
    registered = true;
    registerCliHandlers();
    registerPreflightHandlers();
    registerClaudeUsageHandlers(claudeUsage);
    registerCodexUsageHandlers(codexUsage);
    registerCodexAccountHandlers(codexAccounts);
    registerRateLimitHandlers(rateLimits);
    registerGitHubHandlers(store, stats);
    registerStatsHandlers(stats);
    registerNotificationHandlers(store);
    registerSettingsHandlers(store);
    registerBrowserHandlers();
    // Why: applyPendingCookieImport MUST run before restorePersistedUserAgent
    // because the latter calls session.fromPartition() which initializes
    // CookieMonster. The pending import replaces the live DB file so
    // CookieMonster reads the imported cookies on first access.
    browserSessionRegistry.applyPendingCookieImport();
    browserSessionRegistry.restorePersistedUserAgent();
    registerShellHandlers();
    registerSessionHandlers(store);
    registerUIHandlers(store);
    registerFilesystemHandlers(store);
    registerFilesystemWatcherHandlers();
    registerRuntimeHandlers(runtime);
    registerClipboardHandlers();
    registerUpdaterHandlers(store);
    warmSystemFontFamilies();
}
