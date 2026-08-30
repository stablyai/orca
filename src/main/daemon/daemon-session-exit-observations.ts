import { BoundedMap } from '../../shared/bounded-map'

/**
 * Session ids whose exit this adapter's daemon reported.
 *
 * Why a tombstone rather than `!activeSessionIds.has(id)`: bare absence also describes an
 * id this adapter never owned — a session held by another daemon generation, or one whose
 * tracking a lost socket dropped — and that observes nothing. Only ids whose exit event
 * arrived here may answer `exited`; eviction degrades to `unverifiable`.
 *
 * Why every entry is scoped to an incarnation: daemon session ids are derived from the pane
 * and reused on reopen, so the id alone cannot say WHICH run of the pane a certificate speaks
 * for. Without that, the orderings around a respawn are indistinguishable and each breaks one
 * way — an exit certified while its own spawn was still finalizing looks retirable, an exit
 * reported late by a superseded generation looks like proof about the live replacement, and an
 * exit that names no run at all looks like proof about whichever run you ask about. So the rule
 * is one rule in both directions: once a run is named live, only that run's own exit answers.
 */
export class DaemonSessionExitObservations {
  private readonly observedExits = new BoundedMap<string, string | null>({ maxEntries: 1_024 })
  // The incarnation each session id is currently known to be live as. Kept beside the
  // certificates because retirement has to answer for exits that have not arrived yet.
  private readonly liveIncarnations = new BoundedMap<string, string>({ maxEntries: 1_024 })

  recordExit(sessionId: string, incarnationId?: string): void {
    const liveIncarnationId = this.liveIncarnations.get(sessionId)
    if (liveIncarnationId !== undefined && liveIncarnationId !== incarnationId) {
      // A later incarnation of this pane is already running, so this exit is not about it —
      // either it names an earlier run, or it names none and therefore cannot claim to be the
      // live one's. Unnamed is refused rather than trusted because the only exits that carry no
      // incarnation are the ones a daemon synthesises for a session its host no longer has, and
      // a certificate filed against the shared id would answer for the live pane instead.
      return
    }
    this.observedExits.set(sessionId, incarnationId ?? null)
  }

  /**
   * Why clearing matters: daemon session ids are derived from the pane, so a reopened
   * terminal reuses the id of the one that exited. A certificate that outlived its
   * session would then answer `exited` for a live pane the app merely lost track of.
   *
   * Why it records rather than only deletes: the exit that has to be refused may still be in
   * flight, and a delete cannot reach it. An unidentified incarnation keeps the old
   * delete-everything behaviour, which is all a daemon too old to report one supports.
   */
  clearForLiveSession(sessionId: string, incarnationId?: string): void {
    if (incarnationId === undefined) {
      this.liveIncarnations.delete(sessionId)
      this.observedExits.delete(sessionId)
      return
    }
    this.liveIncarnations.set(sessionId, incarnationId)
    if (this.observedExits.get(sessionId) !== incarnationId) {
      // Keeps a certificate this very incarnation issued: an exit watched during its own
      // spawn finalization is the one record of a death the spawn result cannot report.
      this.observedExits.delete(sessionId)
    }
  }

  verdict(sessionId: string): 'exited' | 'unverifiable' {
    return this.observedExits.has(sessionId) ? 'exited' : 'unverifiable'
  }
}
