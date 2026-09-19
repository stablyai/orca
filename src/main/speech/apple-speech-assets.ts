import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { getAppleSpeechHelperPath } from './apple-speech-helper-binary'
import {
  createAppleSpeechEventReader,
  describeAppleSpeechError,
  type AppleSpeechAssetStatus
} from './apple-speech-events'

const STATUS_TIMEOUT_MS = 10_000

export async function readAppleSpeechAssetStatus(): Promise<AppleSpeechAssetStatus> {
  const helperPath = getAppleSpeechHelperPath()
  if (!helperPath) {
    return 'unsupported'
  }
  const result = await runProcess({
    program: helperPath,
    args: ['status'],
    timeoutMs: STATUS_TIMEOUT_MS
  })
  let status: AppleSpeechAssetStatus = 'unsupported'
  const reader = createAppleSpeechEventReader((event) => {
    if (event.type === 'status') {
      status = event.status
    }
  })
  reader.push(result.stdout)
  reader.flush()
  return status
}

/**
 * Asks macOS to fetch the speech assets for the current dictation language.
 * The files belong to the system and are shared with every other app, so this
 * is an install request rather than a download Orca owns.
 */
export function installAppleSpeechAssets(onProgress: (progress: number) => void): {
  completed: Promise<void>
  abort: () => void
} {
  const helperPath = getAppleSpeechHelperPath()
  if (!helperPath) {
    return {
      completed: Promise.reject(new Error('Apple Speech is unavailable on this Mac.')),
      abort: () => {}
    }
  }
  const child = spawnProcess({ program: helperPath, args: ['install'], timeoutMs: null })
  let installed = false
  let failure: string | null = null
  const reader = createAppleSpeechEventReader((event) => {
    if (event.type === 'progress') {
      onProgress(event.progress)
    } else if (event.type === 'installed') {
      installed = true
    } else if (event.type === 'error') {
      failure = describeAppleSpeechError(event)
    }
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => reader.push(chunk))
  // The caller owns raw stream errors; unhandled, they crash the main process.
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  child.stderr.on('error', () => {})
  child.stderr.resume()

  const completed = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', () => {
      reader.flush()
      if (installed) {
        resolve()
        return
      }
      reject(new Error(failure ?? 'Apple Speech language install failed.'))
    })
  })

  return { completed, abort: () => child.kill() }
}
