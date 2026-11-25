import type { WebContents } from 'electron'

// Choosers are caught per CDP session, and input can reach a frame's session after interception began.

type CoverFrameSession = (sessionId: string) => Promise<void>

const coversByGuest = new WeakMap<WebContents, Set<CoverFrameSession>>()

/** While registered, `cover` extends an active interception to a frame session that input is about to reach. */
export function registerFileChooserFrameCoverage(
  webContents: WebContents,
  cover: CoverFrameSession
): () => void {
  let covers = coversByGuest.get(webContents)
  if (!covers) {
    covers = new Set()
    coversByGuest.set(webContents, covers)
  }
  covers.add(cover)
  return () => {
    covers.delete(cover)
  }
}

/** Rejects when an active interception could not reach the session, so input is not sent there. */
export async function coverFrameSessionWithFileChooserInterception(
  webContents: WebContents,
  sessionId: string
): Promise<void> {
  const covers = coversByGuest.get(webContents)
  if (covers && covers.size > 0) {
    await Promise.all([...covers].map((cover) => cover(sessionId)))
  }
}
