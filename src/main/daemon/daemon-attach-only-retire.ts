/**
 * Pre-v31 daemons ignore `attachOnly`, so attach can accidentally spawn a shell.
 * Retire that spawn before refusing the attach (#12662 / #12589).
 *
 * Retire only through recognized `killOwned`. If the spawn result has no
 * incarnation, or the peer does not implement `killOwned`, skip kill and fail
 * closed. Ordinary `kill` is unchanged. One attempt only.
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
