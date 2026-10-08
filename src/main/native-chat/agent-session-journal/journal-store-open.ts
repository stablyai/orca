import type { JournalLoad } from './journal-open'
import { failLoadOnUnloadableJournal } from './journal-open-failure'

export async function openJournalStoreState(input: {
  sessionId: string
  replay: () => JournalLoad | null
  start: () => void
  adopt: (loaded: JournalLoad) => void
  settleReopenedLiveWork: () => Promise<void>
}): Promise<void> {
  const loaded = input.replay()
  // An epoch named but holding no row (a crash inside an older build's repair) has nothing to
  // keep, so it is founded afresh like a chat with no journal; no row is deleted.
  if (!loaded || (!loaded.newer && !loaded.damage && loaded.state.lastSequence === 0)) {
    input.start()
    return
  }
  failLoadOnUnloadableJournal(input.sessionId, loaded)
  input.adopt(loaded)
  await input.settleReopenedLiveWork()
}
