import { app, shell } from 'electron'
import { configureAiVaultSessionSources } from '../../ai-vault/discovery/ai-vault-session-sources-registry'
import { configureRemoteAiVaultSessionDelete } from '../../ai-vault/deletion/ai-vault-remote-delete-registry'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import { getRuntimeEnvironmentRegistryRoot } from '../runtime-environments/catalog/runtime-environment-registry-root'
import type { AiVaultSessionResumePreparation } from '../../../shared/ai-vault/resume/ai-vault-resume-preparation'

export const AI_VAULT_IPC_CHANNELS = [
  'aiVault:listSessions',
  'aiVault:resolveSessionTitles',
  'aiVault:cancelListSessions',
  'aiVault:prepareSessionResume',
  'aiVault:prepareSessionHandoff',
  'aiVault:listSubagentSessions',
  'aiVault:getFirstUserPrompt',
  'aiVault:deleteSession',
  'aiVault:searchSessions',
  'aiVault:searchStatus',
  'aiVault:setSearchEnabled',
  'aiVault:clearSearchIndex'
] as const

export type LazyAiVaultHandlerOptions = {
  ensureStructuredSessionOwnership: () => Promise<void>
  getAdditionalCodexHomePaths?: () => readonly string[]
  prepareSessionResume?: AiVaultSessionResumePreparation
}

export function registerLazyAiVaultHandlers(options: LazyAiVaultHandlerOptions): void {
  // Configure sources and remote-delete Trash immediately so headless/paired-client RPC works before first desktop IPC.
  configureAiVaultSessionSources({
    getAdditionalCodexHomePaths: options.getAdditionalCodexHomePaths
  })
  configureRemoteAiVaultSessionDelete({
    removePath: (removal) => shell.trashItem(removal.path)
  })

  // macOS app activation skips DOM focus events, so emit the refresh signal here.
  app.on('browser-window-focus', (_event, window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('aiVault:windowFocused')
    }
  })

  registerLazyIpcHandleGroup(AI_VAULT_IPC_CHANNELS, async (ipc) => {
    const [
      { registerAiVaultHandlers },
      { registerAiVaultSearchHandlers },
      { configureRuntimeAiVaultSessionDelete },
      {
        getSavedRuntimeAiVaultHostInfos,
        deleteRuntimeAiVaultSession,
        prepareRuntimeAiVaultSessionResume,
        resolveRuntimeAiVaultSessionTitles,
        scanRuntimeAiVaultSessions
      },
      { callRuntimeSessionSearch }
    ] = await Promise.all([
      import('./ai-vault'),
      import('./ai-vault-search'),
      import('./ai-vault-delete'),
      import('../../ai-vault/runtime-hosts/runtime-session-scanner'),
      import('../../ai-vault/runtime-hosts/runtime-session-search-call')
    ])

    registerAiVaultSearchHandlers(
      {
        callRuntimeSearch: (environmentId, method, params) =>
          callRuntimeSessionSearch(
            getRuntimeEnvironmentRegistryRoot(),
            environmentId,
            method,
            params
          ),
        ensureStructuredSessionOwnership: options.ensureStructuredSessionOwnership
      },
      ipc
    )
    registerAiVaultHandlers(
      {
        getUserDataPath: () => app.getPath('userData'),
        ensureStructuredSessionOwnership: options.ensureStructuredSessionOwnership,
        getAdditionalCodexHomePaths: options.getAdditionalCodexHomePaths,
        prepareSessionResume: options.prepareSessionResume,
        getActiveRuntimeAiVaultHostInfos: async () =>
          await getSavedRuntimeAiVaultHostInfos(getRuntimeEnvironmentRegistryRoot()),
        scanRuntimeAiVaultSessions: async (environmentId, args, scanOptions) =>
          scanRuntimeAiVaultSessions(
            getRuntimeEnvironmentRegistryRoot(),
            environmentId,
            args,
            scanOptions
          ),
        resolveRuntimeAiVaultSessionTitles: async (environmentId, args) =>
          resolveRuntimeAiVaultSessionTitles(
            getRuntimeEnvironmentRegistryRoot(),
            environmentId,
            args
          ),
        prepareRuntimeSessionResume: async (environmentId, args) =>
          prepareRuntimeAiVaultSessionResume(
            getRuntimeEnvironmentRegistryRoot(),
            environmentId,
            args
          )
      },
      ipc,
      { skipWindowFocusListener: true }
    )
    configureRuntimeAiVaultSessionDelete((environmentId, args) =>
      deleteRuntimeAiVaultSession(getRuntimeEnvironmentRegistryRoot(), environmentId, args)
    )
  })
}
