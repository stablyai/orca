import { powerSaveBlocker } from 'electron'

/** Starts a power-save blocker; the returned release stops it once, however often it runs. */
export function holdPowerSaveBlocker(
  type: 'prevent-app-suspension' | 'prevent-display-sleep'
): () => void {
  const id = powerSaveBlocker.start(type)
  return () => {
    if (powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id)
    }
  }
}
