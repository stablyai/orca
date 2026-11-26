// What a chat's workers came to at each read, told to whoever follows them (the thread status lines).
/** What the chat's workers are doing, by the execution host's verdict; `idle` when every open one
 *  waits (on its coordinator or an answer), `none` when none is open. */
export type ConversationWorkerActivity = 'working' | 'unverifiable' | 'idle' | 'none'

/**
 * Why a chat's workers are read: its turn ended (which restarts the running bound), a watch began
 * (whose first read is told even when none runs, since an earlier process may have told otherwise),
 * or a poll while some run.
 */
export type ConversationWorkersRead = 'turn-ended' | 'watch' | 'poll'

/** What a pane's workers came to at its latest read. */
export type ConversationWorkerView = {
  activity: ConversationWorkerActivity
  open: boolean
  /** A running worker has open workers of its own. */
  helpersRunning: boolean
  since: number
  unverifiableSince: number | null
  /** The pane's latest heard turn end's id, once one was read for. */
  lastTurnId: number | null
}

/** Told each pane's read as it applies, when a watch begins, and when the reads it knows are dropped. */
export type ConversationWorkersWatcher = {
  applied: (
    paneKey: string,
    view: ConversationWorkerView,
    reasons: ReadonlySet<ConversationWorkersRead>
  ) => void
  watched: () => void
  forgotten: (paneKey: string) => void
  cleared: () => void
}

let installed: ConversationWorkersWatcher | null = null

/** The process's watcher, set as its conversations are installed. */
export function installConversationWorkersWatcher(
  watcher: ConversationWorkersWatcher | null
): void {
  installed = watcher
}

export function installedConversationWorkersWatcher(): ConversationWorkersWatcher | null {
  return installed
}
