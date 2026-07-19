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

/** Why: `refused` marks an intent:'auto' kill vetoed by a live non-shell
 *  foreground. Old daemons never set it, so callers must treat absence as
 *  "killed, or guard not enforced" until a protocol-version/capability bump
 *  lets them tell the difference. */
export type KillResponse = {
  refused?: true
}
