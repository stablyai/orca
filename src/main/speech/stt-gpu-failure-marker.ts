import { readFileSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import type { SttGpuPolicy } from './stt-worker-cpu-fallback'
import { getSpeechEngineModulesDir } from './stt-worker-paths'

const GPU_FAILURE_MARKER_FILE = 'speech-gpu-failed.json'

let cachedGpuFailureKey: string | null = null

// The GPU is retried once transcribe-cpp or the OS (on macOS, also the GPU driver) changes.
function gpuFailureKey(): string {
  if (cachedGpuFailureKey) {
    return cachedGpuFailureKey
  }
  let version = 'unknown'
  const modulesDir = getSpeechEngineModulesDir('transcribe-cpp')
  if (modulesDir) {
    try {
      version = JSON.parse(
        readFileSync(join(modulesDir, 'transcribe-cpp', 'package.json'), 'utf8')
      ).version
    } catch {
      // An unreadable version keys the marker as 'unknown'; the next good read retries the GPU.
    }
  }
  cachedGpuFailureKey = `${version}|${process.platform}|${process.arch}|${release()}`
  return cachedGpuFailureKey
}

function readMarkerKey(file: string): string | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).key ?? null
  } catch {
    return null
  }
}

/** `gpuEnabled` is the user's Voice setting; the marker records a GPU that failed on this machine. */
export function createSttGpuPolicy(modelsDir: string, gpuEnabled: () => boolean): SttGpuPolicy {
  const file = join(modelsDir, GPU_FAILURE_MARKER_FILE)
  return {
    allowGpu: () => {
      if (!gpuEnabled()) {
        return false
      }
      const marker = readMarkerKey(file)
      return marker === null || marker !== gpuFailureKey()
    },
    markGpuFailed: () => {
      try {
        writeFileSync(file, JSON.stringify({ key: gpuFailureKey() }))
      } catch (error) {
        console.warn('[speech] Could not record the GPU failure:', error)
      }
    }
  }
}
