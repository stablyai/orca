import { ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import { panelSessionTokenSchema } from '../../shared/plugins/frames/plugin-frame-bridge'
import type { PluginHostCallOutcome } from '../../shared/plugins/frames/plugin-protocol'
import { PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS } from '../../shared/plugins/workers/plugin-panel-bridge-protocol'
import {
  PLUGIN_REMOTE_PANEL_CLOSED_CHANNEL,
  type PluginRemotePanelBinding
} from '../../shared/plugins/frames/plugin-remote-panel'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import type { RemoteRuntimeTransportSubscription } from '../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { PluginService } from '../plugins/plugin-service'
import { subscribeRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import { rendererPanelOwner } from './plugin-frame-entry-ipc'
import { PLUGIN_PANEL_PUSH_CHANNEL } from './plugin-panel-push-ipc'
import { hostPanelCallOutcome, hostPanelEventSchema } from './plugin-remote-panel-wire'

const READY_TIMEOUT_MS = 15_000
// The host replays a panel's latest pushes when its stream opens, before the frame listens.
const MAX_EARLY_PUSHES = 64
// The longest host call is a worker request at its maximum timeout.
const CALL_TIMEOUT_MS = PLUGIN_PANEL_REQUEST_MAX_TIMEOUT_MS + 5_000

const bindArgsSchema = z
  .object({
    sessionToken: panelSessionTokenSchema,
    environmentId: z.string().min(1).max(256)
  })
  .strict()
const unbindArgsSchema = z.object({ sessionToken: panelSessionTokenSchema }).strict()
const callSchema = z.object({ sessionToken: panelSessionTokenSchema }).passthrough()

type RemotePanel = {
  sender: WebContents
  sessionToken: string
  environmentId: string
  hostName: string
  subscription: RemoteRuntimeTransportSubscription | null
  hostToken: string | null
  pushOpen: boolean
  earlyPushes: unknown[]
  refs: number
  closed: boolean
  settle: (binding: PluginRemotePanelBinding) => void
  ready: Promise<PluginRemotePanelBinding>
}

/** Panels whose plugin runs on the paired host behind the focused workspace. */
export type RemotePluginPanels = {
  /** True when the session's pushes come from its host, so the local channel stays shut. */
  openPush: (senderId: number, sessionToken: string) => boolean
  closePush: (senderId: number, sessionToken: string) => void
  /** The host's answer to one frame call, or null when the session runs on this machine. */
  forward: (senderId: number, call: unknown) => Promise<PluginHostCallOutcome> | null
}

function panelKey(senderId: number, sessionToken: string): string {
  return `${senderId}\0${sessionToken}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The renderer keeps drawing this machine's copy of the plugin (same files, same consent
 * fingerprint); calls and pushes for that frame go to one `plugins.panelSession` stream on the
 * host, whose socket owns the host's session.
 */
export function registerPluginRemotePanelHandlers(
  pluginService: PluginService
): RemotePluginPanels {
  const panels = new Map<string, RemotePanel>()
  const watchedSenders = new WeakSet<WebContents>()

  const end = (key: string, panel: RemotePanel, reason: string | null): void => {
    if (panel.closed) {
      return
    }
    panel.closed = true
    if (panels.get(key) === panel) {
      panels.delete(key)
    }
    panel.subscription?.close()
    if (!panel.hostToken) {
      panel.settle({ bound: false, reason: reason ?? 'closed' })
      return
    }
    // An explicit unbind needs no notice; a lost host does, so the panel re-reads.
    if (reason !== null && !panel.sender.isDestroyed()) {
      panel.sender.send(PLUGIN_REMOTE_PANEL_CLOSED_CHANNEL, {
        sessionToken: panel.sessionToken,
        reason
      })
    }
  }

  const endAllFor = (senderId: number): void => {
    for (const [key, panel] of panels) {
      if (panel.sender.id === senderId) {
        end(key, panel, null)
      }
    }
  }

  const watch = (sender: WebContents): void => {
    if (watchedSenders.has(sender)) {
      return
    }
    watchedSenders.add(sender)
    const senderId = sender.id
    // A reload keeps the webContents and its tokens, so its streams end with the old document.
    sender.on('did-navigate', () => endAllFor(senderId))
    sender.once('render-process-gone', () => endAllFor(senderId))
    sender.once('destroyed', () => endAllFor(senderId))
  }

  // Ready once the host named its session and the stream that carries its calls is in hand.
  const settleIfReady = (panel: RemotePanel): void => {
    if (!panel.closed && panel.hostToken && panel.subscription) {
      panel.settle({ bound: true, hostName: panel.hostName })
    }
  }

  const sendPush = (panel: RemotePanel, push: unknown): void => {
    if (!panel.sender.isDestroyed()) {
      panel.sender.send(PLUGIN_PANEL_PUSH_CHANNEL, { sessionToken: panel.sessionToken, push })
    }
  }

  const onResponse = (key: string, panel: RemotePanel, response: RuntimeRpcResponse<unknown>) => {
    if (!response.ok) {
      end(key, panel, `${panel.hostName}: ${response.error.message}`)
      return
    }
    const event = hostPanelEventSchema.safeParse(response.result)
    if (!event.success) {
      end(key, panel, `${panel.hostName} sent an unknown panel event`)
      return
    }
    if (event.data.type === 'ready') {
      panel.hostToken = event.data.sessionToken
      settleIfReady(panel)
    } else if (event.data.type === 'push') {
      if (panel.pushOpen) {
        sendPush(panel, event.data.push)
      } else if (panel.earlyPushes.push(event.data.push) > MAX_EARLY_PUSHES) {
        panel.earlyPushes.shift()
      }
    } else {
      end(key, panel, `${panel.hostName} closed the panel`)
    }
  }

  const start = async (
    key: string,
    panel: RemotePanel,
    params: { pluginKey: string; panelId: string; consentFingerprint: string }
  ): Promise<void> => {
    const readyTimer = setTimeout(
      () => end(key, panel, `${panel.hostName} did not open the panel in time`),
      READY_TIMEOUT_MS
    )
    void panel.ready.finally(() => clearTimeout(readyTimer))
    try {
      const subscription = await subscribeRuntimeEnvironment(
        pluginService.options.userDataPath,
        panel.environmentId,
        'plugins.panelSession',
        params,
        READY_TIMEOUT_MS,
        {
          onEvent: (payload) => {
            if (payload.type === 'response') {
              onResponse(key, panel, payload.response)
            } else if (payload.type === 'error') {
              end(key, panel, `${panel.hostName}: ${payload.message}`)
            } else if (payload.type === 'close') {
              end(key, panel, `${panel.hostName} disconnected`)
            }
          },
          onClose: () => end(key, panel, `${panel.hostName} disconnected`)
        }
      )
      if (panel.closed) {
        subscription.close()
        return
      }
      panel.subscription = subscription
      if (!subscription.sendRequest) {
        end(key, panel, `this Orca cannot send panel calls to ${panel.hostName}`)
        return
      }
      settleIfReady(panel)
    } catch (error) {
      end(key, panel, `${panel.hostName}: ${message(error)}`)
    }
  }

  ipcMain.handle(
    'plugins:bindRemotePanel',
    async (event, args: unknown): Promise<PluginRemotePanelBinding> => {
      const parsed = bindArgsSchema.safeParse(args)
      if (!parsed.success) {
        return { bound: false, reason: 'invalid request' }
      }
      await pluginService.whenReady()
      const { sender } = event
      const { sessionToken, environmentId } = parsed.data
      const session = pluginService.panels.sessionCaller(
        rendererPanelOwner(sender.id),
        sessionToken
      )
      const plugin = session ? pluginService.findValidPlugin(session.pluginKey) : null
      if (!session || !plugin || session.caller.surface !== 'panel') {
        return { bound: false, reason: 'this panel is not open' }
      }
      let hostName: string
      try {
        hostName = resolveEnvironment(pluginService.options.userDataPath, environmentId).name
      } catch (error) {
        return { bound: false, reason: message(error) }
      }
      const key = panelKey(sender.id, sessionToken)
      const existing = panels.get(key)
      if (existing && existing.environmentId === environmentId) {
        existing.refs += 1
        return existing.ready
      }
      if (existing) {
        end(key, existing, `the panel moved to another host`)
      }
      watch(sender)
      let settle: RemotePanel['settle'] = () => undefined
      const ready = new Promise<PluginRemotePanelBinding>((resolve) => {
        settle = resolve
      })
      const panel: RemotePanel = {
        sender,
        sessionToken,
        environmentId,
        hostName,
        subscription: null,
        hostToken: null,
        pushOpen: false,
        earlyPushes: [],
        refs: 1,
        closed: false,
        settle,
        ready
      }
      panels.set(key, panel)
      void start(key, panel, {
        pluginKey: session.pluginKey,
        panelId: session.caller.contributionId,
        consentFingerprint: plugin.consentFingerprint
      })
      return ready
    }
  )

  ipcMain.handle('plugins:unbindRemotePanel', (event, args: unknown): void => {
    const parsed = unbindArgsSchema.safeParse(args)
    const key = parsed.success ? panelKey(event.sender.id, parsed.data.sessionToken) : null
    const panel = key ? panels.get(key) : undefined
    if (key && panel && --panel.refs <= 0) {
      end(key, panel, null)
    }
  })

  return {
    openPush: (senderId, sessionToken) => {
      const panel = panels.get(panelKey(senderId, sessionToken))
      if (!panel) {
        return false
      }
      panel.pushOpen = true
      for (const push of panel.earlyPushes.splice(0)) {
        sendPush(panel, push)
      }
      return true
    },
    closePush: (senderId, sessionToken) => {
      const panel = panels.get(panelKey(senderId, sessionToken))
      if (panel) {
        panel.pushOpen = false
      }
    },
    forward: (senderId, call) => {
      const parsed = callSchema.safeParse(call)
      const panel = parsed.success ? panels.get(panelKey(senderId, parsed.data.sessionToken)) : null
      if (!parsed.success || !panel) {
        return null
      }
      const sendRequest = panel.subscription?.sendRequest
      if (!panel.hostToken || !sendRequest) {
        return Promise.resolve({
          ok: false,
          code: 'unavailable',
          error: `${panel.hostName} has not opened this panel yet`
        })
      }
      const { hostName } = panel
      return sendRequest(
        'plugins.panelAction',
        { ...parsed.data, sessionToken: panel.hostToken },
        CALL_TIMEOUT_MS
      ).then(
        (response) => hostPanelCallOutcome(response, hostName),
        (error: unknown): PluginHostCallOutcome => ({
          ok: false,
          code: 'unavailable',
          error: `${hostName} did not answer: ${message(error)}`
        })
      )
    }
  }
}
