/* eslint-disable max-lines -- Why: the preload bridge is the audited contract between
renderer and Electron. Keeping the IPC surface co-located in one file makes security
review and type drift checks easier than scattering these bindings across modules. */
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import { electronAPI } from '@electron-toolkit/preload';
import { ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT } from '../shared/editor-save-events';
import { ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT, ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT } from '../shared/updater-renderer-events';
/**
 * Walk the composed event path to classify which UI surface the native OS drop
 * landed on, and — for file-explorer drops — extract the nearest destination
 * directory from `data-native-file-drop-dir`.
 *
 * Why: the preload layer consumes native OS `drop` events before React can read
 * filesystem paths. If preload does not capture the destination directory at
 * drop time, the renderer can no longer tell whether the user meant "root" or
 * "inside this folder".
 */
function resolveNativeFileDrop(event) {
    const path = event.composedPath();
    let foundExplorer = false;
    let destinationDir;
    for (const entry of path) {
        if (!(entry instanceof HTMLElement)) {
            continue;
        }
        const target = entry.dataset.nativeFileDropTarget;
        if (target === 'editor' || target === 'terminal') {
            return { target };
        }
        if (target === 'file-explorer') {
            foundExplorer = true;
        }
        // Pick the nearest (innermost) destination directory marker
        if (destinationDir === undefined && entry.dataset.nativeFileDropDir) {
            destinationDir = entry.dataset.nativeFileDropDir;
        }
    }
    if (foundExplorer) {
        // Why: routing must fail closed for explorer drops. If preload sees the
        // explorer target marker but cannot resolve a destinationDir, it rejects
        // the gesture and emits no fallback editor drop event.
        if (!destinationDir) {
            return { target: 'rejected' };
        }
        return { target: 'file-explorer', destinationDir };
    }
    return null;
}
// ---------------------------------------------------------------------------
// File drag-and-drop: handled here in the preload because webUtils (which
// resolves File objects to filesystem paths) is only available in Electron's
// preload/main worlds, not the renderer's isolated main world.
// ---------------------------------------------------------------------------
document.addEventListener('dragover', (e) => {
    // Let in-app drags (e.g. file explorer drag-to-move) through to React handlers
    // so they can set their own dropEffect. Only override for native OS file drops.
    if (e.dataTransfer?.types.includes('text/x-orca-file-path')) {
        return;
    }
    e.preventDefault();
    if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
    }
}, true);
document.addEventListener('drop', (e) => {
    // Let in-app drags (e.g. file explorer → terminal) through to React handlers
    if (e.dataTransfer?.types.includes('text/x-orca-file-path')) {
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
        return;
    }
    const resolution = resolveNativeFileDrop(e);
    const paths = [];
    for (let i = 0; i < files.length; i++) {
        // webUtils.getPathForFile is the Electron 28+ replacement for File.path
        const filePath = webUtils.getPathForFile(files[i]);
        if (filePath) {
            paths.push(filePath);
        }
    }
    if (paths.length === 0) {
        return;
    }
    // Why: when the explorer marker was present but no destination directory
    // could be resolved, the gesture is rejected entirely — no fallback to
    // editor, per the fail-closed requirement in design §7.1.
    if (resolution?.target === 'rejected') {
        return;
    }
    // Why: preload must emit exactly one native-drop event per drop gesture.
    // The preload layer already has the full FileList. Re-emitting one IPC
    // message per path and asking the renderer to reconstruct the gesture via
    // timing would be both fragile and slower under large drops.
    if (resolution?.target === 'file-explorer') {
        ipcRenderer.send('terminal:file-dropped-from-preload', {
            paths,
            target: 'file-explorer',
            destinationDir: resolution.destinationDir
        });
    }
    else {
        // Why: falls back to 'editor' so drops on surfaces without an explicit
        // marker (sidebar, editor body, etc.) preserve the prior open-in-editor
        // behavior instead of being silently discarded.
        ipcRenderer.send('terminal:file-dropped-from-preload', {
            paths,
            target: resolution?.target ?? 'editor'
        });
    }
}, true);
// Custom APIs for renderer
const api = {
    repos: {
        list: () => ipcRenderer.invoke('repos:list'),
        add: (args) => ipcRenderer.invoke('repos:add', args),
        addRemote: (args) => ipcRenderer.invoke('repos:addRemote', args),
        remove: (args) => ipcRenderer.invoke('repos:remove', args),
        update: (args) => ipcRenderer.invoke('repos:update', args),
        pickFolder: () => ipcRenderer.invoke('repos:pickFolder'),
        pickDirectory: () => ipcRenderer.invoke('repos:pickDirectory'),
        clone: (args) => ipcRenderer.invoke('repos:clone', args),
        cloneAbort: () => ipcRenderer.invoke('repos:cloneAbort'),
        onCloneProgress: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('repos:clone-progress', listener);
            return () => ipcRenderer.removeListener('repos:clone-progress', listener);
        },
        getGitUsername: (args) => ipcRenderer.invoke('repos:getGitUsername', args),
        getBaseRefDefault: (args) => ipcRenderer.invoke('repos:getBaseRefDefault', args),
        searchBaseRefs: (args) => ipcRenderer.invoke('repos:searchBaseRefs', args),
        onChanged: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('repos:changed', listener);
            return () => ipcRenderer.removeListener('repos:changed', listener);
        }
    },
    worktrees: {
        list: (args) => ipcRenderer.invoke('worktrees:list', args),
        listAll: () => ipcRenderer.invoke('worktrees:listAll'),
        create: (args) => ipcRenderer.invoke('worktrees:create', args),
        remove: (args) => ipcRenderer.invoke('worktrees:remove', args),
        updateMeta: (args) => ipcRenderer.invoke('worktrees:updateMeta', args),
        persistSortOrder: (args) => ipcRenderer.invoke('worktrees:persistSortOrder', args),
        onChanged: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('worktrees:changed', listener);
            return () => ipcRenderer.removeListener('worktrees:changed', listener);
        }
    },
    pty: {
        spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
        write: (id, data) => {
            ipcRenderer.send('pty:write', { id, data });
        },
        resize: (id, cols, rows) => {
            ipcRenderer.send('pty:resize', { id, cols, rows });
        },
        signal: (id, signal) => {
            ipcRenderer.send('pty:signal', { id, signal });
        },
        ackColdRestore: (id) => {
            ipcRenderer.send('pty:ackColdRestore', { id });
        },
        kill: (id) => ipcRenderer.invoke('pty:kill', { id }),
        listSessions: () => ipcRenderer.invoke('pty:listSessions'),
        /** Check if a PTY's shell has child processes (e.g. a running command).
         *  Returns false for an idle shell prompt. */
        hasChildProcesses: (id) => ipcRenderer.invoke('pty:hasChildProcesses', { id }),
        /** Return the PTY foreground process basename when available (e.g. "codex"). */
        getForegroundProcess: (id) => ipcRenderer.invoke('pty:getForegroundProcess', { id }),
        onData: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('pty:data', listener);
            return () => ipcRenderer.removeListener('pty:data', listener);
        },
        onExit: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('pty:exit', listener);
            return () => ipcRenderer.removeListener('pty:exit', listener);
        },
        onOpenCodeStatus: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('pty:opencode-status', listener);
            return () => ipcRenderer.removeListener('pty:opencode-status', listener);
        }
    },
    gh: {
        viewer: () => ipcRenderer.invoke('gh:viewer'),
        repoSlug: (args) => ipcRenderer.invoke('gh:repoSlug', args),
        prForBranch: (args) => ipcRenderer.invoke('gh:prForBranch', args),
        issue: (args) => ipcRenderer.invoke('gh:issue', args),
        workItem: (args) => ipcRenderer.invoke('gh:workItem', args),
        workItemDetails: (args) => ipcRenderer.invoke('gh:workItemDetails', args),
        prFileContents: (args) => ipcRenderer.invoke('gh:prFileContents', args),
        listIssues: (args) => ipcRenderer.invoke('gh:listIssues', args),
        listWorkItems: (args) => ipcRenderer.invoke('gh:listWorkItems', args),
        prChecks: (args) => ipcRenderer.invoke('gh:prChecks', args),
        prComments: (args) => ipcRenderer.invoke('gh:prComments', args),
        resolveReviewThread: (args) => ipcRenderer.invoke('gh:resolveReviewThread', args),
        updatePRTitle: (args) => ipcRenderer.invoke('gh:updatePRTitle', args),
        mergePR: (args) => ipcRenderer.invoke('gh:mergePR', args),
        checkOrcaStarred: () => ipcRenderer.invoke('gh:checkOrcaStarred'),
        starOrca: () => ipcRenderer.invoke('gh:starOrca')
    },
    settings: {
        get: () => ipcRenderer.invoke('settings:get'),
        set: (args) => ipcRenderer.invoke('settings:set', args),
        listFonts: () => ipcRenderer.invoke('settings:listFonts')
    },
    codexAccounts: {
        list: () => ipcRenderer.invoke('codexAccounts:list'),
        add: () => ipcRenderer.invoke('codexAccounts:add'),
        reauthenticate: (args) => ipcRenderer.invoke('codexAccounts:reauthenticate', args),
        remove: (args) => ipcRenderer.invoke('codexAccounts:remove', args),
        select: (args) => ipcRenderer.invoke('codexAccounts:select', args)
    },
    cli: {
        getInstallStatus: () => ipcRenderer.invoke('cli:getInstallStatus'),
        install: () => ipcRenderer.invoke('cli:install'),
        remove: () => ipcRenderer.invoke('cli:remove')
    },
    preflight: {
        check: (args) => ipcRenderer.invoke('preflight:check', args),
        detectAgents: () => ipcRenderer.invoke('preflight:detectAgents')
    },
    notifications: {
        dispatch: (args) => ipcRenderer.invoke('notifications:dispatch', args),
        openSystemSettings: () => ipcRenderer.invoke('notifications:openSystemSettings')
    },
    shell: {
        openPath: (path) => ipcRenderer.invoke('shell:openPath', path),
        openUrl: (url) => ipcRenderer.invoke('shell:openUrl', url),
        openFilePath: (path) => ipcRenderer.invoke('shell:openFilePath', path),
        openFileUri: (uri) => ipcRenderer.invoke('shell:openFileUri', uri),
        pathExists: (path) => ipcRenderer.invoke('shell:pathExists', path),
        pickAttachment: () => ipcRenderer.invoke('shell:pickAttachment'),
        pickImage: () => ipcRenderer.invoke('shell:pickImage'),
        pickDirectory: (args) => ipcRenderer.invoke('shell:pickDirectory', args),
        copyFile: (args) => ipcRenderer.invoke('shell:copyFile', args)
    },
    browser: {
        registerGuest: (args) => ipcRenderer.invoke('browser:registerGuest', args),
        unregisterGuest: (args) => ipcRenderer.invoke('browser:unregisterGuest', args),
        openDevTools: (args) => ipcRenderer.invoke('browser:openDevTools', args),
        onGuestLoadFailed: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:guest-load-failed', listener);
            return () => ipcRenderer.removeListener('browser:guest-load-failed', listener);
        },
        onPermissionDenied: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:permission-denied', listener);
            return () => ipcRenderer.removeListener('browser:permission-denied', listener);
        },
        onPopup: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:popup', listener);
            return () => ipcRenderer.removeListener('browser:popup', listener);
        },
        onDownloadRequested: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:download-requested', listener);
            return () => ipcRenderer.removeListener('browser:download-requested', listener);
        },
        onDownloadProgress: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:download-progress', listener);
            return () => ipcRenderer.removeListener('browser:download-progress', listener);
        },
        onDownloadFinished: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:download-finished', listener);
            return () => ipcRenderer.removeListener('browser:download-finished', listener);
        },
        onContextMenuRequested: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:context-menu-requested', listener);
            return () => ipcRenderer.removeListener('browser:context-menu-requested', listener);
        },
        onContextMenuDismissed: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:context-menu-dismissed', listener);
            return () => ipcRenderer.removeListener('browser:context-menu-dismissed', listener);
        },
        onOpenLinkInOrcaTab: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:open-link-in-orca-tab', listener);
            return () => ipcRenderer.removeListener('browser:open-link-in-orca-tab', listener);
        },
        acceptDownload: (args) => ipcRenderer.invoke('browser:acceptDownload', args),
        cancelDownload: (args) => ipcRenderer.invoke('browser:cancelDownload', args),
        setGrabMode: (args) => ipcRenderer.invoke('browser:setGrabMode', args),
        awaitGrabSelection: (args) => ipcRenderer.invoke('browser:awaitGrabSelection', args),
        cancelGrab: (args) => ipcRenderer.invoke('browser:cancelGrab', args),
        captureSelectionScreenshot: (args) => ipcRenderer.invoke('browser:captureSelectionScreenshot', args),
        extractHoverPayload: (args) => ipcRenderer.invoke('browser:extractHoverPayload', args),
        onGrabModeToggle: (callback) => {
            const listener = (_event, browserPageId) => callback(browserPageId);
            ipcRenderer.on('browser:grabModeToggle', listener);
            return () => ipcRenderer.removeListener('browser:grabModeToggle', listener);
        },
        onGrabActionShortcut: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('browser:grabActionShortcut', listener);
            return () => ipcRenderer.removeListener('browser:grabActionShortcut', listener);
        },
        sessionListProfiles: () => ipcRenderer.invoke('browser:session:listProfiles'),
        sessionCreateProfile: (args) => ipcRenderer.invoke('browser:session:createProfile', args),
        sessionDeleteProfile: (args) => ipcRenderer.invoke('browser:session:deleteProfile', args),
        sessionImportCookies: (args) => ipcRenderer.invoke('browser:session:importCookies', args),
        sessionResolvePartition: (args) => ipcRenderer.invoke('browser:session:resolvePartition', args),
        sessionDetectBrowsers: () => ipcRenderer.invoke('browser:session:detectBrowsers'),
        sessionImportFromBrowser: (args) => ipcRenderer.invoke('browser:session:importFromBrowser', args),
        sessionClearDefaultCookies: () => ipcRenderer.invoke('browser:session:clearDefaultCookies')
    },
    hooks: {
        check: (args) => ipcRenderer.invoke('hooks:check', args),
        createIssueCommandRunner: (args) => ipcRenderer.invoke('hooks:createIssueCommandRunner', args),
        readIssueCommand: (args) => ipcRenderer.invoke('hooks:readIssueCommand', args),
        writeIssueCommand: (args) => ipcRenderer.invoke('hooks:writeIssueCommand', args)
    },
    cache: {
        getGitHub: () => ipcRenderer.invoke('cache:getGitHub'),
        setGitHub: (args) => ipcRenderer.invoke('cache:setGitHub', args)
    },
    session: {
        get: () => ipcRenderer.invoke('session:get'),
        set: (args) => ipcRenderer.invoke('session:set', args),
        /** Synchronous session save for beforeunload — blocks until flushed to disk. */
        setSync: (args) => {
            ipcRenderer.sendSync('session:set-sync', args);
        }
    },
    updater: {
        getStatus: () => ipcRenderer.invoke('updater:getStatus'),
        getVersion: () => ipcRenderer.invoke('updater:getVersion'),
        check: () => ipcRenderer.invoke('updater:check'),
        download: () => ipcRenderer.invoke('updater:download'),
        dismissNudge: () => ipcRenderer.invoke('updater:dismissNudge'),
        quitAndInstall: async () => {
            // Why: quitAndInstall closes the BrowserWindow directly from the main
            // process. Renderer beforeunload guards treat that like a normal window
            // close unless we mark the updater path explicitly, and #300 introduced
            // longer-lived editor dirty/autosave state that can otherwise veto the
            // restart even after the update payload has been downloaded.
            window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_STARTED_EVENT));
            // Why: we wrap the save attempt in try/catch so that a save failure
            // (e.g., unsupported dirty files or a write error) never silently
            // prevents the update from installing. The user already clicked
            // "install update" — proceeding with the restart is better than
            // leaving them stuck with no feedback.
            try {
                await new Promise((resolve, reject) => {
                    let claimed = false;
                    window.dispatchEvent(new CustomEvent(ORCA_EDITOR_SAVE_DIRTY_FILES_EVENT, {
                        detail: {
                            claim: () => {
                                claimed = true;
                            },
                            resolve,
                            reject: (message) => {
                                reject(new Error(message));
                            }
                        }
                    }));
                    // Why: updater installs can run when no editor surface is mounted.
                    // When nothing claims the request there are no in-memory editor buffers
                    // to flush, so proceed with the normal shutdown path immediately.
                    if (!claimed) {
                        resolve();
                    }
                });
            }
            catch (error) {
                console.warn('[updater] Saving dirty files before quit failed; proceeding with install anyway:', error);
            }
            // Dispatch beforeunload to trigger terminal buffer capture before the
            // update process bypasses the normal window close sequence (quitAndInstall
            // removes close listeners, preventing beforeunload from firing naturally).
            window.dispatchEvent(new Event('beforeunload'));
            try {
                return await ipcRenderer.invoke('updater:quitAndInstall');
            }
            catch (error) {
                window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT));
                throw error;
            }
        },
        onStatus: (callback) => {
            const listener = (_event, status) => callback(status);
            ipcRenderer.on('updater:status', listener);
            return () => ipcRenderer.removeListener('updater:status', listener);
        },
        onClearDismissal: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('updater:clearDismissal', listener);
            return () => ipcRenderer.removeListener('updater:clearDismissal', listener);
        }
    },
    fs: {
        readDir: (args) => ipcRenderer.invoke('fs:readDir', args),
        readFile: (args) => ipcRenderer.invoke('fs:readFile', args),
        writeFile: (args) => ipcRenderer.invoke('fs:writeFile', args),
        createFile: (args) => ipcRenderer.invoke('fs:createFile', args),
        createDir: (args) => ipcRenderer.invoke('fs:createDir', args),
        rename: (args) => ipcRenderer.invoke('fs:rename', args),
        deletePath: (args) => ipcRenderer.invoke('fs:deletePath', args),
        authorizeExternalPath: (args) => ipcRenderer.invoke('fs:authorizeExternalPath', args),
        stat: (args) => ipcRenderer.invoke('fs:stat', args),
        listFiles: (args) => ipcRenderer.invoke('fs:listFiles', args),
        search: (args) => ipcRenderer.invoke('fs:search', args),
        importExternalPaths: (args) => ipcRenderer.invoke('fs:importExternalPaths', args),
        watchWorktree: (args) => ipcRenderer.invoke('fs:watchWorktree', args),
        unwatchWorktree: (args) => ipcRenderer.invoke('fs:unwatchWorktree', args),
        onFsChanged: (callback) => {
            const listener = (_event, payload) => callback(payload);
            ipcRenderer.on('fs:changed', listener);
            return () => ipcRenderer.removeListener('fs:changed', listener);
        }
    },
    git: {
        status: (args) => ipcRenderer.invoke('git:status', args),
        conflictOperation: (args) => ipcRenderer.invoke('git:conflictOperation', args),
        diff: (args) => ipcRenderer.invoke('git:diff', args),
        branchCompare: (args) => ipcRenderer.invoke('git:branchCompare', args),
        branchDiff: (args) => ipcRenderer.invoke('git:branchDiff', args),
        stage: (args) => ipcRenderer.invoke('git:stage', args),
        bulkStage: (args) => ipcRenderer.invoke('git:bulkStage', args),
        unstage: (args) => ipcRenderer.invoke('git:unstage', args),
        bulkUnstage: (args) => ipcRenderer.invoke('git:bulkUnstage', args),
        discard: (args) => ipcRenderer.invoke('git:discard', args),
        remoteFileUrl: (args) => ipcRenderer.invoke('git:remoteFileUrl', args)
    },
    ui: {
        get: () => ipcRenderer.invoke('ui:get'),
        set: (args) => ipcRenderer.invoke('ui:set', args),
        onOpenSettings: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:openSettings', listener);
            return () => ipcRenderer.removeListener('ui:openSettings', listener);
        },
        onToggleLeftSidebar: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:toggleLeftSidebar', listener);
            return () => ipcRenderer.removeListener('ui:toggleLeftSidebar', listener);
        },
        onToggleRightSidebar: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:toggleRightSidebar', listener);
            return () => ipcRenderer.removeListener('ui:toggleRightSidebar', listener);
        },
        onToggleWorktreePalette: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:toggleWorktreePalette', listener);
            return () => ipcRenderer.removeListener('ui:toggleWorktreePalette', listener);
        },
        onOpenQuickOpen: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:openQuickOpen', listener);
            return () => ipcRenderer.removeListener('ui:openQuickOpen', listener);
        },
        onJumpToWorktreeIndex: (callback) => {
            const listener = (_event, index) => callback(index);
            ipcRenderer.on('ui:jumpToWorktreeIndex', listener);
            return () => ipcRenderer.removeListener('ui:jumpToWorktreeIndex', listener);
        },
        onNewBrowserTab: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:newBrowserTab', listener);
            return () => ipcRenderer.removeListener('ui:newBrowserTab', listener);
        },
        onNewTerminalTab: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:newTerminalTab', listener);
            return () => ipcRenderer.removeListener('ui:newTerminalTab', listener);
        },
        onFocusBrowserAddressBar: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:focusBrowserAddressBar', listener);
            return () => ipcRenderer.removeListener('ui:focusBrowserAddressBar', listener);
        },
        onFindInBrowserPage: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:findInBrowserPage', listener);
            return () => ipcRenderer.removeListener('ui:findInBrowserPage', listener);
        },
        onReloadBrowserPage: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:reloadBrowserPage', listener);
            return () => ipcRenderer.removeListener('ui:reloadBrowserPage', listener);
        },
        onHardReloadBrowserPage: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:hardReloadBrowserPage', listener);
            return () => ipcRenderer.removeListener('ui:hardReloadBrowserPage', listener);
        },
        onCloseActiveTab: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:closeActiveTab', listener);
            return () => ipcRenderer.removeListener('ui:closeActiveTab', listener);
        },
        onSwitchTab: (callback) => {
            const listener = (_event, direction) => callback(direction);
            ipcRenderer.on('ui:switchTab', listener);
            return () => ipcRenderer.removeListener('ui:switchTab', listener);
        },
        onToggleStatusBar: (callback) => {
            const listener = (_event) => callback();
            ipcRenderer.on('ui:toggleStatusBar', listener);
            return () => ipcRenderer.removeListener('ui:toggleStatusBar', listener);
        },
        onActivateWorktree: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('ui:activateWorktree', listener);
            return () => ipcRenderer.removeListener('ui:activateWorktree', listener);
        },
        onTerminalZoom: (callback) => {
            const listener = (_event, direction) => callback(direction);
            ipcRenderer.on('terminal:zoom', listener);
            return () => ipcRenderer.removeListener('terminal:zoom', listener);
        },
        readClipboardText: () => ipcRenderer.invoke('clipboard:readText'),
        saveClipboardImageAsTempFile: () => ipcRenderer.invoke('clipboard:saveImageAsTempFile'),
        writeClipboardText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
        writeClipboardImage: (dataUrl) => ipcRenderer.invoke('clipboard:writeImage', dataUrl),
        onFileDrop: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('terminal:file-drop', listener);
            return () => ipcRenderer.removeListener('terminal:file-drop', listener);
        },
        getZoomLevel: () => webFrame.getZoomLevel(),
        setZoomLevel: (level) => webFrame.setZoomLevel(level),
        syncTrafficLights: (zoomFactor) => ipcRenderer.send('ui:sync-traffic-lights', zoomFactor),
        onFullscreenChanged: (callback) => {
            const listener = (_event, isFullScreen) => callback(isFullScreen);
            ipcRenderer.on('window:fullscreen-changed', listener);
            return () => ipcRenderer.removeListener('window:fullscreen-changed', listener);
        },
        /** Fired by the main process when the user tries to close the window
         *  (X button, Cmd+Q, etc.). Renderer should show a confirmation dialog
         *  if terminals are still running, then call confirmWindowClose().
         *  When isQuitting is true, the close was initiated by app.quit() (Cmd+Q)
         *  and the renderer should skip the running-process dialog. */
        onWindowCloseRequested: (callback) => {
            const listener = (_event, data) => callback(data ?? { isQuitting: false });
            ipcRenderer.on('window:close-requested', listener);
            return () => ipcRenderer.removeListener('window:close-requested', listener);
        },
        /** Tell the main process to proceed with the window close. */
        confirmWindowClose: () => {
            ipcRenderer.send('window:confirm-close');
        }
    },
    stats: {
        getSummary: () => ipcRenderer.invoke('stats:summary')
    },
    claudeUsage: {
        getScanState: () => ipcRenderer.invoke('claudeUsage:getScanState'),
        setEnabled: (args) => ipcRenderer.invoke('claudeUsage:setEnabled', args),
        refresh: (args) => ipcRenderer.invoke('claudeUsage:refresh', args),
        getSummary: (args) => ipcRenderer.invoke('claudeUsage:getSummary', args),
        getDaily: (args) => ipcRenderer.invoke('claudeUsage:getDaily', args),
        getBreakdown: (args) => ipcRenderer.invoke('claudeUsage:getBreakdown', args),
        getRecentSessions: (args) => ipcRenderer.invoke('claudeUsage:getRecentSessions', args)
    },
    codexUsage: {
        getScanState: () => ipcRenderer.invoke('codexUsage:getScanState'),
        setEnabled: (args) => ipcRenderer.invoke('codexUsage:setEnabled', args),
        refresh: (args) => ipcRenderer.invoke('codexUsage:refresh', args),
        getSummary: (args) => ipcRenderer.invoke('codexUsage:getSummary', args),
        getDaily: (args) => ipcRenderer.invoke('codexUsage:getDaily', args),
        getBreakdown: (args) => ipcRenderer.invoke('codexUsage:getBreakdown', args),
        getRecentSessions: (args) => ipcRenderer.invoke('codexUsage:getRecentSessions', args)
    },
    runtime: {
        syncWindowGraph: (graph) => ipcRenderer.invoke('runtime:syncWindowGraph', graph),
        getStatus: () => ipcRenderer.invoke('runtime:getStatus')
    },
    rateLimits: {
        get: () => ipcRenderer.invoke('rateLimits:get'),
        refresh: () => ipcRenderer.invoke('rateLimits:refresh'),
        setPollingInterval: (ms) => ipcRenderer.invoke('rateLimits:setPollingInterval', ms),
        onUpdate: (callback) => {
            const listener = (_event, state) => callback(state);
            ipcRenderer.on('rateLimits:update', listener);
            return () => ipcRenderer.removeListener('rateLimits:update', listener);
        }
    },
    ssh: {
        listTargets: () => ipcRenderer.invoke('ssh:listTargets'),
        addTarget: (args) => ipcRenderer.invoke('ssh:addTarget', args),
        updateTarget: (args) => ipcRenderer.invoke('ssh:updateTarget', args),
        removeTarget: (args) => ipcRenderer.invoke('ssh:removeTarget', args),
        importConfig: () => ipcRenderer.invoke('ssh:importConfig'),
        connect: (args) => ipcRenderer.invoke('ssh:connect', args),
        disconnect: (args) => ipcRenderer.invoke('ssh:disconnect', args),
        getState: (args) => ipcRenderer.invoke('ssh:getState', args),
        testConnection: (args) => ipcRenderer.invoke('ssh:testConnection', args),
        onStateChanged: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('ssh:state-changed', listener);
            return () => ipcRenderer.removeListener('ssh:state-changed', listener);
        },
        addPortForward: (args) => ipcRenderer.invoke('ssh:addPortForward', args),
        removePortForward: (args) => ipcRenderer.invoke('ssh:removePortForward', args),
        listPortForwards: (args) => ipcRenderer.invoke('ssh:listPortForwards', args),
        browseDir: (args) => ipcRenderer.invoke('ssh:browseDir', args),
        onCredentialRequest: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('ssh:credential-request', listener);
            return () => ipcRenderer.removeListener('ssh:credential-request', listener);
        },
        onCredentialResolved: (callback) => {
            const listener = (_event, data) => callback(data);
            ipcRenderer.on('ssh:credential-resolved', listener);
            return () => ipcRenderer.removeListener('ssh:credential-resolved', listener);
        },
        submitCredential: (args) => ipcRenderer.invoke('ssh:submitCredential', args)
    }
};
// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI);
        contextBridge.exposeInMainWorld('api', api);
    }
    catch (error) {
        console.error(error);
    }
}
else {
    // @ts-ignore (define in dts)
    window.electron = electronAPI;
    // @ts-ignore (define in dts)
    window.api = api;
}
