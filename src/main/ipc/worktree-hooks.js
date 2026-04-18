// Why: extracted from worktrees.ts to keep the main IPC module under the
// max-lines threshold. Hooks IPC handlers (check, readIssueCommand,
// writeIssueCommand) are self-contained and don't interact with worktree
// creation or removal state.
import { ipcMain } from 'electron';
import { join } from 'path';
import { isFolderRepo } from '../../shared/repo-kind';
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch';
import { hasHooksFile, hasUnrecognizedOrcaYamlKeys, loadHooks, readIssueCommand, writeIssueCommand } from '../hooks';
export function registerHooksHandlers(store) {
    ipcMain.removeHandler('hooks:check');
    ipcMain.removeHandler('hooks:readIssueCommand');
    ipcMain.removeHandler('hooks:writeIssueCommand');
    ipcMain.handle('hooks:check', async (_event, args) => {
        const repo = store.getRepo(args.repoId);
        if (!repo || isFolderRepo(repo)) {
            return { hasHooks: false, hooks: null, mayNeedUpdate: false };
        }
        // Why: remote repos read orca.yaml via the SSH filesystem provider.
        // Parsing happens in the main process since it's CPU-cheap and avoids
        // adding YAML parsing to the relay.
        if (repo.connectionId) {
            const fsProvider = getSshFilesystemProvider(repo.connectionId);
            if (!fsProvider) {
                return { hasHooks: false, hooks: null, mayNeedUpdate: false };
            }
            try {
                const result = await fsProvider.readFile(join(repo.path, '.orca.yaml'));
                if (result.isBinary) {
                    return { hasHooks: false, hooks: null, mayNeedUpdate: false };
                }
                const { parse } = await import('yaml');
                const parsed = parse(result.content);
                return { hasHooks: true, hooks: parsed, mayNeedUpdate: false };
            }
            catch {
                return { hasHooks: false, hooks: null, mayNeedUpdate: false };
            }
        }
        const has = hasHooksFile(repo.path);
        const hooks = has ? loadHooks(repo.path) : null;
        // Why: when a newer Orca version adds a top-level key to `orca.yaml`, older
        // versions that don't recognise it return null and show "could not be parsed".
        // Detecting well-formed but unrecognised keys lets the UI suggest updating
        // instead of implying the file is broken.
        const mayNeedUpdate = has && !hooks && hasUnrecognizedOrcaYamlKeys(repo.path);
        return {
            hasHooks: has,
            hooks,
            mayNeedUpdate
        };
    });
    ipcMain.handle('hooks:readIssueCommand', async (_event, args) => {
        const repo = store.getRepo(args.repoId);
        if (!repo || isFolderRepo(repo)) {
            return {
                localContent: null,
                sharedContent: null,
                effectiveContent: null,
                localFilePath: '',
                source: 'none'
            };
        }
        if (repo.connectionId) {
            const fsProvider = getSshFilesystemProvider(repo.connectionId);
            if (!fsProvider) {
                return {
                    localContent: null,
                    sharedContent: null,
                    effectiveContent: null,
                    localFilePath: '',
                    source: 'none'
                };
            }
            try {
                const result = await fsProvider.readFile(join(repo.path, '.orca', 'issue-command'));
                return {
                    localContent: result.isBinary ? null : result.content,
                    sharedContent: null,
                    effectiveContent: result.isBinary ? null : result.content,
                    localFilePath: join(repo.path, '.orca', 'issue-command'),
                    source: 'local'
                };
            }
            catch {
                return {
                    localContent: null,
                    sharedContent: null,
                    effectiveContent: null,
                    localFilePath: '',
                    source: 'none'
                };
            }
        }
        return readIssueCommand(repo.path);
    });
    ipcMain.handle('hooks:writeIssueCommand', async (_event, args) => {
        const repo = store.getRepo(args.repoId);
        if (!repo || isFolderRepo(repo)) {
            return;
        }
        if (repo.connectionId) {
            const fsProvider = getSshFilesystemProvider(repo.connectionId);
            if (!fsProvider) {
                return;
            }
            await fsProvider.writeFile(join(repo.path, '.orca', 'issue-command'), args.content);
            return;
        }
        writeIssueCommand(repo.path, args.content);
    });
}
