// Why: split out of types.ts (at its max-lines cap) when kill gained the
// intent field; kill-request semantics can evolve here without crowding it.
export type KillRequest = {
  id: string
  type: 'kill'
  payload: {
    sessionId: string
    immediate?: boolean
    /** Why: 'auto' = lifecycle-driven kill, refused while a live non-shell
     *  foreground runs. Absent = legacy kill; old daemons ignore the field. */
    intent?: 'auto' | 'user'
  }
}
