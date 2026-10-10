import type { JournalLoad } from './journal-open'
import { failLoadOnUnloadableJournal } from './journal-open-failure'

/** Replays the saved journal. What a gone writer left live is read as saved: its owner's exit, the
 *  next acquisition, or startup settles it, never this open. */
export function openJournalStoreState(input: {
  sessionId: string
  replay: () => JournalLoad | null
  start: () => void
  adopt: (loaded: JournalLoad) => void
}): void {
  const loaded = input.replay()
  // An epoch named but holding no row (a crash inside an older build's repair) has nothing to
  // keep, so it is founded afresh like a chat with no journal; no row is deleted.
  if (!loaded || (!loaded.newer && !loaded.damage && loaded.state.lastSequence === 0)) {
    input.start()
    return
  }
  failLoadOnUnloadableJournal(input.sessionId, loaded)
  input.adopt(loaded)
}
