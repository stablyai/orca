import type { MountAdapter, MountContext } from '../recording-scenario'
import { hookMount, performHookAction } from '../hook-mount'
import type { operationModuleLoader } from '../operation-module-loader'

const DICTATION_ID = 'dictation-1'
const MODEL_ID = 'whisper-small'

/** The keep-awake owner the desktop-start flow serializes against; acquire/release are observed. */
function keepAwakeOwner(effect: MountContext['effect']) {
  return {
    acquire: (id: string) => {
      effect('keep-awake-acquire', { id })
      return Promise.resolve()
    },
    release: (id?: string) => {
      effect('keep-awake-release', { id: id ?? null })
      return Promise.resolve()
    },
    reacquire: (id: string) => {
      effect('keep-awake-reacquire', { id })
      return Promise.resolve()
    }
  }
}

/**
 * The dictation setup sheet's four senders, the desktop session handshake, one audio chunk, and
 * the session hook that owns finish and cancel.
 *
 * The chunk is enqueued directly rather than through a microphone event so the recording carries
 * the base64 the real encoder produced for known bytes: the substitute audio module never fires an
 * event, so a driven emitter would be the adapter's payload rather than the product's.
 */
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
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the owner members the start flow calls.
            keepAwakeOwner: keepAwakeOwner(effect) as unknown as Parameters<
              typeof start
            >[0]['keepAwakeOwner'],
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
      const enqueue = modules.load<typeof import('../../../hooks/mobile-dictation-audio-chunk')>(
        'mobile/src/hooks/mobile-dictation-audio-chunk.ts'
      ).enqueueMobileDictationAudioChunk
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
              shouldReleaseBudget: () => true,
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
