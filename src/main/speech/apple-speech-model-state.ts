import type { SpeechModelState, SpeechModelStatus } from '../../shared/speech-types'
import { installAppleSpeechAssets, readAppleSpeechAssetStatus } from './apple-speech-assets'

type SpeechModelStateWriter = (
  modelId: string,
  status: SpeechModelStatus,
  progress?: number,
  error?: string
) => void

/**
 * Maps what macOS says about its speech assets onto the states the settings
 * list already renders for downloadable models.
 */
export async function readAppleSpeechModelState(modelId: string): Promise<SpeechModelState> {
  const status = await readAppleSpeechAssetStatus()
  switch (status) {
    case 'installed':
      return { id: modelId, status: 'ready' }
    case 'downloading':
      return { id: modelId, status: 'downloading' }
    case 'unsupported':
      return {
        id: modelId,
        status: 'error',
        error: 'macOS does not offer speech assets for your dictation language.'
      }
    case 'supported':
      // Available for this Mac, but its assets are not on disk yet.
      return { id: modelId, status: 'not-downloaded' }
  }
}

export async function installAppleSpeechModel(
  modelId: string,
  updateState: SpeechModelStateWriter,
  activeInstalls: Map<string, { abort: () => void }>
): Promise<void> {
  updateState(modelId, 'downloading', 0)
  const install = installAppleSpeechAssets((progress) =>
    updateState(modelId, 'downloading', progress)
  )
  let canceled = false
  activeInstalls.set(modelId, {
    abort: () => {
      canceled = true
      install.abort()
    }
  })
  try {
    await install.completed
    updateState(modelId, 'ready')
  } catch (err) {
    if (canceled) {
      return
    }
    console.error('[speech] Apple Speech asset install failed:', err)
    updateState(modelId, 'error', undefined, String(err))
    throw err
  } finally {
    activeInstalls.delete(modelId)
  }
}
