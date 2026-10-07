import type { ImageAddon } from '@xterm/addon-image'
import { buildMainModelSnapshotReplayWrites } from '../../shared/terminal-snapshot-replay-writes'
import type {
  HeadlessModelCheckpoint,
  HeadlessModelConfiguration
} from './headless-model-checkpoint'
import type { HeadlessEmulator } from './headless-emulator'

export async function prepareHeadlessModelCheckpoint(
  checkpoint: HeadlessModelCheckpoint,
  construct: (configuration: HeadlessModelConfiguration) => HeadlessEmulator,
  addonOf: (model: HeadlessEmulator) => ImageAddon | undefined,
  options: { isCurrent?: () => boolean }
): Promise<HeadlessEmulator> {
  const check = (): void => {
    checkpoint.checkCurrent()
    if (options.isCurrent?.() === false) {
      throw new Error('Terminal model changed during preparation')
    }
  }
  check()
  const { configuration, snapshot } = checkpoint.metadata
  const staged = construct(configuration)
  try {
    const writes = buildMainModelSnapshotReplayWrites(
      {
        data: snapshot.rehydrateSequences + snapshot.snapshotAnsi,
        alternateScreen: snapshot.modes.alternateScreen,
        scrollbackAnsi: snapshot.scrollbackAnsi
      },
      { paneOnAlternateScreen: false }
    )
    for (const write of writes) {
      await staged.write(write)
      check()
    }
    await staged.applyKittyKeyboardFlags(snapshot.modes.kittyKeyboardFlags ?? 0)
    check()
    const addon = addonOf(staged)
    if (!addon) {
      throw new Error('Missing staging image addon')
    }
    await checkpoint.restoreImages(addon)
    check()
    if (snapshot.pendingEscapeTailAnsi) {
      await staged.write(snapshot.pendingEscapeTailAnsi)
      check()
    }
    staged.setCwd(snapshot.cwd)
    if (snapshot.lastTitle !== undefined) {
      staged.setLastTitle(snapshot.lastTitle)
    }
    staged.setRestoredOscLinks(snapshot.oscLinks)
    return staged
  } catch (error) {
    staged.dispose()
    throw error
  }
}
