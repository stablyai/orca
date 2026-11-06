// A hung host proof must not outlast the settle it would have saved.
const SHELL_FOREGROUND_PROOF_DEADLINE_MS = 250

export type IdleShellPromptEvidence = {
  /** Launch/foreground records or any agent-status row, live or stale. */
  hasPaneAgent: () => boolean
  /** Consumes the OSC 133 hint so back-to-back sends cannot reuse one prompt. */
  claimPromptMarker: () => boolean
  /** The execution host's proof that the shell itself owns the terminal foreground. */
  confirmShellForeground: (() => Promise<boolean>) | null
}

/** True only when markers and the execution host both prove a bare shell at its prompt. */
export async function claimIdleShellPrompt(evidence: IdleShellPromptEvidence): Promise<boolean> {
  if (evidence.hasPaneAgent() || !evidence.claimPromptMarker()) {
    return false
  }
  const proof = evidence.confirmShellForeground?.()
  if (!proof) {
    return false
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SHELL_FOREGROUND_PROOF_DEADLINE_MS)
    timer.unref?.()
  })
  try {
    return await Promise.race([proof.catch(() => false), deadline])
  } finally {
    clearTimeout(timer)
  }
}
