import { registerSpeechApplicationHandlers } from './speech/speech-application-handlers'
import { publishToDocuments } from './app-registry/app-handler-registry'
import {
  ipcMain,
  BrowserWindow,
  systemPreferences,
  type IpcMainInvokeEvent,
  type MessagePortMain
} from 'electron'
import { abortWhenRendererGone } from './renderer-requests/renderer-lifetime-abort'
import { dictationTermsFor } from '../../shared/speech/dictation/dictation-dictionary'
import { dictationTextSettingsFor } from '../../shared/speech/dictation/dictation-cleanup'

import { getSpeechSttService } from '../speech/speech-runtime-service'

import type { DictationContext } from '../../shared/speech/speech-types'
import type { Store } from '../persistence/loading-store/store'

import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/execution/commit-message-agent-environment'

export function registerSpeechHandlers(
  store: Store,
  agentEnvResolvers?: CommitMessageAgentEnvironmentResolvers
): void {
  registerSpeechApplicationHandlers(store, agentEnvResolvers, () => getSpeechSttService(store))

  // Renderer run ids restart per document; a retired document's owner must not be reused by its successor.
  const retiredDocumentCounts = new Map<number, number>()
  const getDesktopOwner = (senderId: number, sessionId: string): string =>
    `desktop:${senderId}:${retiredDocumentCounts.get(senderId) ?? 0}:${sessionId}`

  const dictationListeners = new Map<number, { owner: string; cleanup: () => void }>()

  // The preload posts a session's audio port just before its start, on the same ordered pipe.
  const pendingAudioPorts = new Map<string, MessagePortMain>()
  ipcMain.on('speech:audioPort', (event, sessionId: string) => {
    const port = event.ports[0]
    if (port) {
      pendingAudioPorts.set(getDesktopOwner(event.sender.id, sessionId), port)
    }
  })

  ipcMain.handle(
    'speech:startDictation',
    async (event, modelId: string, context?: DictationContext, sessionId = 'desktop') => {
      const senderId = event.sender.id
      const owner = getDesktopOwner(senderId, sessionId)
      const audioPort = pendingAudioPorts.get(owner)
      pendingAudioPorts.delete(owner)
      let directAudio = false
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        audioPort?.close()
        return { directAudio }
      }
      let rendererRetired = false
      const rendererLifetime = abortWhenRendererGone(event.sender)
      let sessionListenerRemoved = false
      let sessionReady = false
      const cleanupOnRendererGone = (): void => {
        if (!rendererRetired && getDesktopOwner(senderId, sessionId) === owner) {
          retiredDocumentCounts.set(senderId, (retiredDocumentCounts.get(senderId) ?? 0) + 1)
        }
        rendererRetired = true
        cleanupSessionListener()
        void getSpeechSttService(store)
          .stopDictation(owner, { discard: true })
          .catch(() => {})
      }
      const cleanupSessionListener = (): void => {
        sessionListenerRemoved = true
        window.off('closed', cleanupOnRendererGone)
        rendererLifetime.dispose()
        if (dictationListeners.get(senderId)?.cleanup === cleanupSessionListener) {
          dictationListeners.delete(senderId)
        }
      }
      window.once('closed', cleanupOnRendererGone)
      rendererLifetime.signal.addEventListener('abort', cleanupOnRendererGone, { once: true })

      try {
        // macOS can return silent microphone streams without TCC permission; request it before capture.
        if (process.platform === 'darwin') {
          const micStatus = systemPreferences.getMediaAccessStatus('microphone')
          if (micStatus !== 'granted') {
            await systemPreferences.askForMediaAccess('microphone')
            const newStatus = systemPreferences.getMediaAccessStatus('microphone')
            if (newStatus !== 'granted') {
              throw new Error(
                'Microphone access not granted. In System Settings > Privacy & Security > Microphone, ' +
                  'click "+" and add the Electron app, then restart Orca.'
              )
            }
          }
        }

        if (rendererRetired || window.isDestroyed()) {
          cleanupSessionListener()
          return { directAudio }
        }

        await getSpeechSttService(store).startDictation(
          modelId,
          (msg) => {
            if (msg.type === 'ready') {
              sessionReady = true
            }
            if (rendererRetired || window.isDestroyed()) {
              return
            }
            switch (msg.type) {
              case 'ready':
                publishToDocuments(
                  'speech:ready',
                  { sessionId },
                  { sourceId: window.webContents.id }
                )
                break
              case 'partial':
                publishToDocuments(
                  'speech:partial',
                  { text: msg.text ?? '', sessionId },
                  { sourceId: window.webContents.id }
                )
                break
              case 'final':
                publishToDocuments(
                  'speech:final',
                  { text: msg.text ?? '', sessionId },
                  { sourceId: window.webContents.id }
                )
                break
              case 'speech-pending':
                publishToDocuments(
                  'speech:pending',
                  { pending: msg.pending, sessionId },
                  { sourceId: window.webContents.id }
                )
                break
              case 'stopped':
                cleanupSessionListener()
                publishToDocuments(
                  'speech:stopped',
                  { sessionId },
                  { sourceId: window.webContents.id }
                )
                break
              case 'error':
                publishToDocuments(
                  'speech:error',
                  { error: msg.error ?? '', sessionId },
                  { sourceId: window.webContents.id }
                )
                void getSpeechSttService(store)
                  .stopDictation(owner)
                  .catch(() => undefined)
                  .finally(cleanupSessionListener)
                break
            }
          },
          dictationTermsFor(store.getSettings().voice, {
            dictationTerms: context?.repoTerms,
            displayName: context?.repoName
          }),
          owner,
          dictationTextSettingsFor(store.getSettings())
        )
        // Coalesced starts install no sink; only an accepted start supersedes the close hook.
        if (sessionReady) {
          directAudio =
            audioPort !== undefined && getSpeechSttService(store).attachAudioPort(owner, audioPort)
          dictationListeners.get(senderId)?.cleanup()
          if (!sessionListenerRemoved) {
            dictationListeners.set(senderId, { owner, cleanup: cleanupSessionListener })
          }
        } else {
          cleanupSessionListener()
        }
        return { directAudio }
      } catch (err) {
        cleanupSessionListener()
        throw err
      } finally {
        if (!directAudio) {
          audioPort?.close()
        }
      }
    }
  )

  ipcMain.handle(
    'speech:feedAudio',
    async (_event, buffer: Buffer, sampleRate: number, sessionId = 'desktop') => {
      // Preload uses Buffer because contextBridge/IPC can zero Float32Array data.
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
      return getSpeechSttService(store).feedAudio(
        samples,
        sampleRate,
        getDesktopOwner(_event.sender.id, sessionId)
      )
    }
  )

  const handleStop =
    (discard: boolean) =>
    async (event: IpcMainInvokeEvent, sessionId = 'desktop'): Promise<void> => {
      const owner = getDesktopOwner(event.sender.id, sessionId)
      const listener = dictationListeners.get(event.sender.id)
      await getSpeechSttService(store).stopDictation(owner, { discard })
      if (listener?.owner === owner) {
        listener.cleanup()
      }
    }
  ipcMain.handle('speech:stopDictation', handleStop(false))
  ipcMain.handle('speech:cancelDictation', handleStop(true))
}
