import { createGenerationStore } from './generation-store'
import { createExpoGenerationFileSystem } from './generation-store-file-system'

/** A removed host's recorded update failures go with it. Not gated on the build: a native build
 *  installed over an OTA one inherits its cache, and with no log this only reads a missing file. */
export function forgetHostUpdateFailures(hostId: string): Promise<void> {
  return createGenerationStore({
    fileSystem: createExpoGenerationFileSystem()
  }).forgetHostUpdateFailures(hostId)
}
