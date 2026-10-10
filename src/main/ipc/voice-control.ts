import {
  BrowserWindow,
  app,
  ipcMain,
  powerMonitor,
  systemPreferences,
  type WebContents
} from 'electron'
import { randomUUID } from 'node:crypto'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getMainHttpClient } from '../network/http-client'
import { hasOpenAiSpeechApiKey, readOpenAiSpeechApiKey } from '../speech/openai-api-key-store'
import { getDefaultVoiceControlSettings } from '../../shared/constants'
import { localOrchestrationCliCommand } from '../runtime/orchestration/cli-command'
import type {
  VoiceControlAgentActivityEvent,
  VoiceControlExchangeSdpResult,
  VoiceControlStartResult,
  VoiceControlToolActivityEvent,
  VoiceScreenSnapshot
} from '../../shared/voice-control-types'
import { VoiceControlService } from '../voice-control/voice-control-service'
import { createVoiceControlBackendFactory } from '../voice-control/voice-control-backend-wiring'
import { VoiceScreenDriver } from '../voice-control/voice-control-screen-driver'
import { createVoiceOwnerDebuggerCache } from '../voice-control/voice-control-owner-debugger'
import {
  VoiceControlTranscriptLog,
  voiceControlTranscriptLogPath
} from '../voice-control/voice-control-transcript-log'

/**
 * IPC surface for the voice control. The service is a process-wide singleton (one session
 * at a time) owned by the window that started it; that window receives the state and
 * tool-activity pushes, and closing it ends the session.
 */
export function registerVoiceControlHandlers(store: Store, runtime: OrcaRuntimeService): void {
  let ownerWebContentsId: number | null = null
  // Cached at claim time — a getAllWindows().find() scan per push fires on every
  // state/tool/transcript event of a live session.
  let ownerWebContents: WebContents | null = null
  const releaseOwner = (): void => {
    ownerWebContentsId = null
    ownerWebContents = null
  }

  const sendToOwner = (channel: string, payload: unknown): void => {
    if (ownerWebContents && !ownerWebContents.isDestroyed()) {
      ownerWebContents.send(channel, payload)
    }
  }

  // describe_screen: the renderer owns the on-screen truth (tabs, focus, sidebars), so
  // the tool does a request/response round-trip to the owner window, bounded so a wedged
  // renderer degrades to an honest "can't see it" instead of hanging the model's turn.
  const pendingScreenSnapshots = new Map<string, (snapshot: VoiceScreenSnapshot | null) => void>()
  ipcMain.on(
    'voice-control:screenSnapshotResponse',
    (_event, payload: { requestId: string; snapshot: VoiceScreenSnapshot }) => {
      pendingScreenSnapshots.get(payload.requestId)?.(payload.snapshot)
      pendingScreenSnapshots.delete(payload.requestId)
    }
  )
  const requestScreenSnapshot = (): Promise<VoiceScreenSnapshot | null> => {
    if (ownerWebContentsId === null) {
      return Promise.resolve(null)
    }
    const requestId = randomUUID()
    return new Promise((resolve) => {
      pendingScreenSnapshots.set(requestId, resolve)
      setTimeout(() => {
        if (pendingScreenSnapshots.delete(requestId)) {
          resolve(null)
        }
      }, 2_000).unref()
      sendToOwner('voice-control:screenSnapshotRequest', requestId)
    })
  }

  // see_screen / click_element / type_into drive the OWNER window over its own CDP
  // debugger — the browser-automation snapshot engine reused for the main window. No
  // renderer cooperation, so no preload skew; a DevTools-held debugger degrades to null.
  // The wrapper MUST be identity-stable per webContents (the driver tells its own
  // attachment from the user's DevTools by identity) — hence the cache.
  const ownerDebuggers = createVoiceOwnerDebuggerCache()
  const screenDriver = new VoiceScreenDriver({
    getDebugger: () => {
      if (!ownerWebContents || ownerWebContents.isDestroyed()) {
        return null
      }
      return ownerDebuggers.forWebContents(ownerWebContents)
    }
  })

  const getSettings = () => store.getSettings().voice?.control ?? getDefaultVoiceControlSettings()
  const getRoster = async () => (await runtime.getWorktreePs()).worktrees
  const emitToolActivity = (event: VoiceControlToolActivityEvent) =>
    sendToOwner('voice-control:toolActivity', event)
  const emitAgentActivity = (event: VoiceControlAgentActivityEvent) =>
    sendToOwner('voice-control:agentActivity', event)

  // The durable transcript: one log for the process, written by the service (user +
  // assistant lines) and the backend (commands, work updates). The panel backfills from
  // the log and follows live via the same entries, pushed here at the single choke point.
  const transcriptLog = new VoiceControlTranscriptLog(
    voiceControlTranscriptLogPath(app.getPath('userData'))
  )
  const recordTranscript = (entry: Parameters<VoiceControlTranscriptLog['append']>[0]) => {
    transcriptLog.append(entry)
    sendToOwner('voice-control:transcriptEntry', entry)
  }

  // Lazily defer getMainHttpClient() so registration can happen before app-ready.
  const service = new VoiceControlService({
    http: { fetch: (url, init) => getMainHttpClient().fetch(url, init) },
    hasApiKey: hasOpenAiSpeechApiKey,
    readApiKey: readOpenAiSpeechApiKey,
    getRoster,
    getSettings,
    emitState: (event) => sendToOwner('voice-control:stateChanged', event),
    emitToolActivity,
    emitAgentActivity,
    cliCommand: localOrchestrationCliCommand(),
    recordTranscript,
    readRecentTranscript: () => transcriptLog.read(),
    createBackend: createVoiceControlBackendFactory({
      store,
      runtime,
      getSettings,
      getRoster,
      emitToolActivity,
      emitAgentActivity,
      recordTranscript,
      describeScreen: requestScreenSnapshot,
      seeScreen: () => screenDriver.seeScreen(),
      performUiAction: (action) =>
        action.kind === 'click'
          ? screenDriver.clickElement(action.ref)
          : screenDriver.typeInto(action.ref, action.text),
      readTerminal: () => screenDriver.readTerminalText(),
      focusPane: (messages) => {
        for (const message of messages) {
          sendToOwner(message.channel, message.payload)
        }
      }
    })
  })

  ipcMain.handle('voice-control:getTranscript', () => transcriptLog.read())

  ipcMain.handle('voice-control:start', async (event): Promise<VoiceControlStartResult> => {
    // Why: macOS TCC silently returns a zeroed audio track without this grant — same
    // check dictation performs (see ipc/speech.ts).
    if (process.platform === 'darwin') {
      if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
        await systemPreferences.askForMediaAccess('microphone')
        if (systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
          return {
            ok: false,
            errorKind: 'mic-denied',
            error:
              'Microphone access not granted. In System Settings > Privacy & Security > Microphone, grant Orca microphone access, then restart Orca.'
          }
        }
      }
    }
    // A previous error parks the service in 'error'; treat start as the retry path.
    if (service.getState().state === 'error') {
      await service.stop('retry')
    }
    if (service.getState().state !== 'idle') {
      return { ok: false, errorKind: 'unknown', error: 'voice_control_already_active' }
    }
    // Claim ownership before start so the minting/awaiting-sdp transitions reach us.
    ownerWebContentsId = event.sender.id
    ownerWebContents = event.sender
    const sessionId = randomUUID()
    const failure = await service.start(sessionId)
    if (failure) {
      releaseOwner()
      return { ok: false, errorKind: failure.kind, error: failure.error }
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    window?.once('closed', () => {
      releaseOwner()
      void service.stop('window-closed')
    })
    return { ok: true, sessionId }
  })

  ipcMain.handle(
    'voice-control:exchangeSdp',
    async (event, sessionId: string, offerSdp: string): Promise<VoiceControlExchangeSdpResult> => {
      if (ownerWebContentsId !== event.sender.id) {
        return { ok: false, errorKind: 'unknown', error: 'voice_control_not_session_owner' }
      }
      const result = await service.exchangeSdp(sessionId, offerSdp)
      if ('answerSdp' in result) {
        return { ok: true, answerSdp: result.answerSdp }
      }
      return { ok: false, errorKind: result.kind, error: result.error }
    }
  )

  ipcMain.handle('voice-control:stop', async (event, sessionId: string) => {
    // Why the error carve-out: a failed start parks the service in 'error' AND
    // releases ownership, so the pill's Dismiss would otherwise be refused forever.
    if (ownerWebContentsId !== event.sender.id && service.getState().state !== 'error') {
      return
    }
    if (service.getState().sessionId !== sessionId) {
      return
    }
    // Stop first so the final state events still reach the owner, then release it.
    await service.stop()
    releaseOwner()
  })

  ipcMain.handle('voice-control:getState', () => service.getState())

  // The transcript panel's composer: typed/pasted text becomes a user turn. Owner-only,
  // length-capped like any other input path.
  ipcMain.handle('voice-control:sendUserText', (event, sessionId: string, text: string) => {
    if (ownerWebContentsId !== event.sender.id || typeof text !== 'string') {
      return
    }
    const trimmed = text.trim()
    if (trimmed.length === 0 || trimmed.length > 4_000) {
      return
    }
    service.sendUserText(sessionId, trimmed)
  })

  // Sleep suspends the OS network stack; the sideband and the peer connection are dead on
  // resume even before the OS notices. End the session and tell the renderer to re-start
  // fresh (ephemeral credentials are cheap; a zombie live state is not).
  powerMonitor.on('resume', () => {
    const { state } = service.getState()
    if (state === 'live' || state === 'minting' || state === 'awaiting-sdp') {
      void service.stop('power-resume').then(() => {
        sendToOwner('voice-control:systemResume', {})
      })
    }
  })
}
