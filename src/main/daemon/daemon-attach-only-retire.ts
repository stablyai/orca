/**
 * Pre-v31 daemons ignore `attachOnly`, so attach can accidentally spawn a shell.
 * Retire that spawn before refusing the attach (#12662 / #12589).
 *
 * One kill only: the kill RPC is session-id keyed (not incarnation-fenced), so a
 * retry after an ambiguous timeout can murder a legitimate re-create under the
 * same stable id. Observability of a failed retire is the support surface.
 */

export type AttachOnlyRetireResult = { ok: true } | { ok: false; error: unknown }

/** Kill an accidental attach-only spawn once. */
export async function retireAccidentalAttachOnlySpawn(args: {
  kill: () => Promise<void>
}): Promise<AttachOnlyRetireResult> {
  try {
    await args.kill()
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}
