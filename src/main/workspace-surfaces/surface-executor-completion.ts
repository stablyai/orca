import type { PtyCreationDisposition } from '../../shared/pty-creation-disposition'

export async function completedSurfaceCreation(
  disposition: PtyCreationDisposition | undefined
): Promise<boolean> {
  if (!disposition) {
    return false
  }
  if (disposition.kind === 'no-fork') {
    return true
  }
  if (disposition.kind === 'unknown') {
    await disposition.recover?.()
    return false
  }
  await disposition.recover?.()
  await disposition.completion
  return disposition.kind === 'physical' && disposition.exitCode() !== null
}
