// Electron wiring for local commands: the bridge's real dependencies and its IPC. Every handler
// answers only the trusted app window; nothing a browser guest or plugin frame sends is accepted.
import { app, ipcMain, Notification } from 'electron'
import { z } from 'zod'
import {
  LOCAL_COMMANDS_ATTACH_METHOD,
  LOCAL_COMMANDS_SETTLE_METHOD,
  type LocalCommandSettleParams
} from '../../shared/local-commands/local-command-contract'
import {
  LOCAL_COMMANDS_PROMPTS_CHANNEL,
  LOCAL_COMMANDS_STATE_CHANNEL,
  type LocalCommandPrompt
} from '../../shared/local-commands/local-command-desktop-types'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from '../hosted-sandbox/hosted-sandbox-driver'
import {
  listTeamCloudRuntimes,
  readOrcaCloudActiveAccountId
} from '../hosted-sandbox/orca-cloud-active-account'
import { getCloudWorkspacesService } from '../ipc/cloud-workspaces'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { getTrustedUIRendererWindow, isTrustedUIRenderer, sendToTrustedUIRenderer } from '../ipc/ui'
import { retainNotificationUntilRelease } from '../ipc/native-notification-lifecycle'
import { translateMain } from '../i18n/main-i18n'
import { hostShellEnvironment } from '../runtime/agent-session/environment/structured-agent-shell-environment'
import { safelyRevealWindow } from '../window/focus-existing-window'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'
import { LocalCommandAuditLog } from './local-command-audit-log'
import {
  createLocalCommandBridge,
  type LocalCloudWorkspaceRef,
  type LocalCommandBridge
} from './local-command-bridge'
import {
  buildLocalCommandEnv,
  executeLocalCommand,
  localCommandsSupported,
  resolveLocalCommandCwd,
  stopAllLocalCommands
} from './local-command-executor'
import { isLocalCommandSandboxId, LocalCommandSettingsStore } from './local-command-settings-store'
import { onEphemeralVmRuntimesChanged } from '../../shared/ephemeral-vm-runtime-store-events'
import { eventField } from './local-command-request-checks'
import {
  createLocalCommandSettingsController,
  type LocalCommandSettingsController
} from './local-command-settings-controller'

const SETTLE_TIMEOUT_MS = 15_000
const ENDED_STATUSES = new Set(['failed', 'cleanup_pending', 'cleanup_failed', 'cleaned'])

let bridge: LocalCommandBridge | null = null
let controller: LocalCommandSettingsController | null = null
let stopWatchingRuntimes: (() => void) | null = null
let auditLog: LocalCommandAuditLog | null = null

function listLocalCloudWorkspaces(userDataPath: string): LocalCloudWorkspaceRef[] {
  const refs: LocalCloudWorkspaceRef[] = []
  for (const runtime of listTeamCloudRuntimes(userDataPath, readOrcaCloudActiveAccountId())) {
    if (!runtime.recipeResult || ENDED_STATUSES.has(runtime.status)) {
      continue
    }
    const handle = environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    if (!handle || !isLocalCommandSandboxId(handle.environmentId)) {
      continue
    }
    refs.push({
      sandboxId: handle.environmentId,
      runtimeEnvironmentId: runtime.runtimeEnvironmentId ?? null,
      fallbackLabel: runtime.workspaceName ?? handle.environmentId
    })
  }
  return refs
}

function notifyPrompt(prompt: LocalCommandPrompt): void {
  const win = getTrustedUIRendererWindow()
  if (!Notification.isSupported() || (win && !win.isDestroyed() && win.isFocused())) {
    return
  }
  // The command itself stays out of the banner (lock screens show it); the dialog has it.
  const notification = new Notification({
    title: translateMain('localCommands.notification.title', 'Run a command on this computer?'),
    body: translateMain(
      'localCommands.notification.body',
      'An agent in {{workspace}} is waiting for your approval.',
      { workspace: prompt.workspaceLabel }
    )
  })
  const onClick = (): void => {
    release()
    const target = getTrustedUIRendererWindow()
    if (!target || target.isDestroyed()) {
      return
    }
    if (process.platform === 'darwin' && !isBackgroundLaunch()) {
      app.focus({ steal: true })
    }
    safelyRevealWindow(target)
  }
  const release = retainNotificationUntilRelease(notification, () => {
    notification.removeListener('click', onClick)
  })
  notification.on('click', onClick)
  notification.show()
}

/** Orca Cloud builds only; call once the control plane is configured. */
export function installLocalCommands(userDataPath: string): void {
  if (bridge) {
    return
  }
  const settings = new LocalCommandSettingsStore(userDataPath)
  const audit = new LocalCommandAuditLog(userDataPath)
  auditLog = audit
  const supported = localCommandsSupported()
  const listWorkspaces = (): LocalCloudWorkspaceRef[] => listLocalCloudWorkspaces(userDataPath)
  const publishState = (): void => sendToTrustedUIRenderer(LOCAL_COMMANDS_STATE_CHANNEL, null)
  bridge = createLocalCommandBridge({
    settings,
    audit,
    supported,
    listWorkspaces,
    readPolicy: async (sandboxId) => {
      const service = await getCloudWorkspacesService().catch(() => null)
      const result = await service?.get(sandboxId)
      const record = result?.ok ? result.value : null
      return record
        ? {
            isOwner: record.access === 'owner',
            shared: record.visibility !== 'private',
            title: record.title
          }
        : null
    },
    subscribe: async (environmentId, onEvent, onClose) =>
      subscribeRuntimeEnvironment(
        userDataPath,
        environmentId,
        LOCAL_COMMANDS_ATTACH_METHOD,
        {},
        SETTLE_TIMEOUT_MS,
        {
          onEvent: (payload) => {
            if (payload.type === 'response' && payload.response.ok) {
              onEvent(payload.response.result)
            }
          },
          onClose
        }
      ),
    settle: async (environmentId: string, params: LocalCommandSettleParams) => {
      const response = await callRuntimeEnvironment(
        userDataPath,
        environmentId,
        LOCAL_COMMANDS_SETTLE_METHOD,
        params,
        SETTLE_TIMEOUT_MS
      )
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const result = response.result
      const accepted = eventField(result, 'accepted')
      // A claim counts only when orcad says so in so many words.
      return { accepted: accepted === true }
    },
    resolveCwd: (requested) => resolveLocalCommandCwd(requested),
    execute: async ({ command, cwd, timeoutSec }) => {
      const shellEnv = await hostShellEnvironment().catch((): NodeJS.ProcessEnv => ({}))
      return executeLocalCommand({
        command,
        cwd,
        timeoutSec,
        env: buildLocalCommandEnv(shellEnv.PATH)
      })
    },
    publishPrompts: (prompts) => sendToTrustedUIRenderer(LOCAL_COMMANDS_PROMPTS_CHANNEL, prompts),
    publishState,
    onPromptAdded: notifyPrompt
  })
  controller = createLocalCommandSettingsController({
    bridge,
    settings,
    supported,
    listWorkspaces,
    publishState
  })
  // Nothing attaches until this computer's own switches are read.
  void settings.load().then(() => bridge?.reconcile())
  // A created, woken, rolled-over or deleted workspace changes the records: attach where they point.
  stopWatchingRuntimes = onEphemeralVmRuntimesChanged(() => bridge?.reconcile())
  app.once('before-quit', () => {
    stopWatchingRuntimes?.()
    bridge?.dispose()
    stopAllLocalCommands()
  })
}

const SetEnabled = z
  .object({ sandboxId: z.string(), enabled: z.boolean(), allowShared: z.boolean().optional() })
  .strict()
const Decide = z
  .object({
    id: z.string().regex(/^lc_[A-Za-z0-9_-]{16,64}$/),
    decision: z.enum(['allow-once', 'always-allow', 'deny'])
  })
  .strict()

const CHANNELS = [
  'localCommands:getState',
  'localCommands:setEnabled',
  'localCommands:removeRule',
  'localCommands:listAudit',
  'localCommands:getPrompts',
  'localCommands:decide'
] as const

const UNAVAILABLE = { available: false, workspaces: [], rules: [] }

export function registerLocalCommandHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const handle = (channel: (typeof CHANNELS)[number], fn: (args: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, args: unknown) => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('untrusted_sender')
      }
      return fn(args)
    })
  }
  handle('localCommands:getState', () => controller?.state() ?? UNAVAILABLE)
  handle('localCommands:getPrompts', () => bridge?.prompts() ?? [])
  handle('localCommands:setEnabled', async (args) => {
    const parsed = SetEnabled.safeParse(args)
    if (!parsed.success || !isLocalCommandSandboxId(parsed.data.sandboxId)) {
      return { ok: false, error: 'invalid_request' }
    }
    return controller
      ? controller.setEnabled(
          parsed.data.sandboxId,
          parsed.data.enabled,
          parsed.data.allowShared === true
        )
      : { ok: false, error: 'unsupported' }
  })
  handle('localCommands:removeRule', (args) =>
    typeof args === 'string' && args.length <= 64 ? (controller?.removeRule(args) ?? false) : false
  )
  handle('localCommands:listAudit', (args) => {
    const limit = typeof args === 'number' && Number.isInteger(args) ? args : 50
    return auditLog?.recent(limit) ?? []
  })
  handle('localCommands:decide', async (args) => {
    const parsed = Decide.safeParse(args)
    if (!parsed.success) {
      return { ok: false, error: 'invalid_request' }
    }
    return bridge
      ? bridge.decide(parsed.data.id, parsed.data.decision)
      : { ok: false, error: 'not_found' }
  })
}
