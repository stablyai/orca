import { isShellProcess } from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'

export type PtyShellForegroundEvidenceSource = {
  /** The provider's cheap, possibly cached, foreground read. */
  readForegroundProcess(): Promise<string | null> | null
  /** Fresh process evidence, or null when the provider cannot confirm. */
  confirmForegroundProcess(): Promise<string | null> | null
  /** Runs after each read settles so the caller can reject evidence from a replaced PTY. */
  afterRead?(): void
}

/**
 * True when a shell owns the PTY foreground and fresh evidence does not prove an agent there.
 *
 * Why this failure policy: callers ask it before trusting weak agent evidence (a hook status or a
 * restored title) for sends. An unreadable foreground keeps that evidence; once the cheap read shows
 * a shell, only a recognized agent in fresh evidence overrules it, so doubt never types into a shell.
 */
export async function ptyForegroundIsShell(
  source: PtyShellForegroundEvidenceSource
): Promise<boolean> {
  let foreground: string | null
  try {
    foreground = await source.readForegroundProcess()
  } catch {
    source.afterRead?.()
    return false
  }
  source.afterRead?.()
  if (!foreground || !isShellProcess(foreground)) {
    return false
  }
  let confirmed: string | null
  try {
    const confirmation = source.confirmForegroundProcess()
    if (confirmation === null) {
      return true
    }
    confirmed = await confirmation
  } catch {
    source.afterRead?.()
    return true
  }
  source.afterRead?.()
  // Why: hook identity is generic; strong provider evidence only needs to
  // prove that some recognized agent still owns this exact PTY.
  return recognizeAgentProcess(confirmed) === null
}
