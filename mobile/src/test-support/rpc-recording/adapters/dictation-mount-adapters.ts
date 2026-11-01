import type { MountAdapter } from '../recording-scenario'
import { hookMount, performHookAction } from '../hook-mount'
import type { operationModuleLoader } from '../operation-module-loader'
import type * as AudioChunkModule from '../../../hooks/mobile-dictation-audio-chunk'

const DICTATION_ID = 'dictation-1'
const MODEL_ID = 'whisper-small'

// Enqueue known encoded audio directly; inert substitute microphone events would otherwise make payloads adapter inventions.
export function dictationMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'speech.setup-sheet': ({ client }) => {
      const setup = modules.load<typeof import('../../../dictation/mobile-dictation-setup')>(
        'mobile/src/dictation/mobile-dictation-setup.ts'
      )
      const results: Record<string, unknown> = {}
      return {
        action(name, args) {
          if (name !== 'download' && name !== 'delete' && name !== 'configure' && name !== 'list') {
            throw new Error(`Unknown dictation setup action: ${name}`)
          }
          const modelId = String(args.modelId ?? MODEL_ID)
          const request =
            name === 'download'
              ? setup.downloadDictationModel(client, modelId)
              : name === 'delete'
                ? setup.deleteDictationModel(client, modelId)
                : name === 'configure'
                  ? setup.setDictationConfig(client, { enabled: true, modelId })
                  : setup.fetchDictationSetup(client)
          return request.then((value: unknown) => {
            results[name] = value === undefined ? 'started' : value
            return value
          })
        },
        state: () => ({ ...results }),
        dispose: () => {}
      }
    },
    'speech.desktop-start': ({ client, effect }) => {
      const start = modules.load<typeof import('../../../hooks/mobile-dictation-desktop-start')>(
        'mobile/src/hooks/mobile-dictation-desktop-start.ts'
      ).startMobileDictationDesktopSession
      let generation = 1
      let activeId: string | null = DICTATION_ID
      let started: unknown = 'unstarted'
      let idle = false
      return {
        action(name, args) {
          if (name === 'supersede') {
            generation += 1
            return
          }
          if (name !== 'start') {
            throw new Error(`Unknown dictation start action: ${name}`)
          }
          return start({
            client,
            dictationId: DICTATION_ID,
            generation: 1,
            getCurrentGeneration: () => generation,
            getEnabled: () => true,
            getActiveId: () => activeId,
            clearActiveId: (id: string) => {
              if (activeId === id) {
                activeId = null
              }
            },
            setIdle: () => {
              idle = true
            },
            commitRecordingStart: () => args.recording !== false,
            rollbackRecordingStart: () => effect('rollback-recording', {})
          }).then((value: unknown) => {
            started = value
            return value
          })
        },
        state: () => ({ started, activeId, idle }),
        dispose: () => {}
      }
    },
    'speech.audio-chunk': ({ client, effect }) => {
      const chunks = modules.load<typeof AudioChunkModule>(
        'mobile/src/hooks/mobile-dictation-audio-chunk.ts'
      )
      const enqueue = chunks.enqueueMobileDictationAudioChunk
      const budget = modules.load<
        typeof import('../../../hooks/mobile-dictation-pending-audio-budget')
      >('mobile/src/hooks/mobile-dictation-pending-audio-budget.ts')
      const pendingChunks = new Set<Promise<void>>()
      const pendingAudioBudget = new budget.MobileDictationPendingAudioBudget()
      const failures: string[] = []
      return {
        action: (_name, args) => {
          const bytes = Uint8Array.from(
            { length: Number(args.length ?? 8) },
            (_value, index) => (index * 37) % 256
          )
          enqueue(
            client,
            DICTATION_ID,
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chunk sender reads only `data` off the microphone event.
            { data: bytes } as unknown as Parameters<typeof enqueue>[2],
            {
              pendingChunks,
              pendingAudioBudget,
              isActive: () => true,
              transcriptSoFar: new chunks.MobileDictationTranscriptSoFar(),
              failActiveDictation: (id: string, error: unknown) => {
                failures.push(error instanceof Error ? error.message : String(error))
                effect('dictation-failed', { id })
              }
            }
          )
          return Promise.allSettled(pendingChunks)
        },
        state: () => ({ pending: pendingChunks.size, failures: [...failures] }),
        dispose: () => {}
      }
    },
    'speech.dictation-session': ({ client, effect }) => {
      const useDictation = modules.load<typeof import('../../../hooks/use-mobile-dictation')>(
        'mobile/src/hooks/use-mobile-dictation.ts'
      ).useMobileDictation
      let session: ReturnType<typeof useDictation>
      const transcripts: string[] = []
      const hook = hookMount(() => {
        session = useDictation({
          client,
          enabled: true,
          onTranscript: (text: string) => transcripts.push(text),
          onError: (error: Error) => effect('dictation-error', { message: error.message })
        })
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'start') {
            return performHookAction(() => session.start())
          }
          if (name === 'cancel') {
            return performHookAction(() => session.cancel())
          }
          if (name === 'stop') {
            return performHookAction(() => session.stop())
          }
          throw new Error(`Unknown dictation session action: ${name}`)
        },
        state: () => ({
          status: session.status,
          error: session.error,
          transcripts: [...transcripts]
        }),
        dispose: hook.unmount
      }
    }
  }
}
