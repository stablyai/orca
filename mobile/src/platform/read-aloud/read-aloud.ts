import type { ReadAloudEngine } from './read-aloud-contract'
import { speakOnDevice, stopOnDevice } from './native-read-aloud-device'

const deviceEngine: ReadAloudEngine = { available: true, speak: speakOnDevice, stop: stopOnDevice }

export function useReadAloudEngine(): ReadAloudEngine {
  return deviceEngine
}
