import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDefaultSettings } from '../../../../shared/constants'
import { finishPtyShutdown } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { ClaudeProfileRouter } from '../../../claude-accounts/claude-profile-router'
import { claudeProfileMarkerPath } from '../../../claude-accounts/claude-profile-paths'
import type { ClaudeManagedAccount } from '../../../../shared/managed-account-types'

export function makeReplacementDeps(): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null
  })
  return {
    store: undefined,
    getSettings: () => ({
      ...getDefaultSettings('/tmp'),
      terminalWindowsShell: 'powershell.exe'
    }),
    adoptStablePane: async () => null,
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    assertWorkspaceAcceptsNewPty: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only `operations.ts` (write/clearBuffer) reads `mainWindow`; the spawn preflight and option build never touch it, and a real BrowserWindow cannot exist in vitest.
    mainWindow: {} as BrowserWindow
  }
}

export function replacementRouter(root: string): ClaudeProfileRouter {
  const account: ClaudeManagedAccount = {
    id: 'b',
    email: 'b@example.test',
    authMethod: 'subscription-oauth',
    managedAuthPath: '/unused-legacy',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 1
  }
  return new ClaudeProfileRouter({
    getSettings: () => ({
      ...getDefaultSettings(root),
      claudeManagedAccounts: [
        account,
        { ...account, id: 'a', email: 'a@example.test' },
        { ...account, id: 'w', managedAuthRuntime: 'wsl' }
      ],
      activeClaudeManagedAccountId: 'a',
      agentStatusHooksEnabled: false
    }),
    dataRoot: join(root, 'data'),
    userHome: join(root, 'personal'),
    env: {},
    refreshWaitMs: 10,
    runSetup: async ({ profile }) => {
      mkdirSync(profile.home, { recursive: true })
      writeFileSync(claudeProfileMarkerPath(profile), '{}')
      return { outcome: 'prepared', warnings: [], surfaces: {} }
    }
  })
}
