import { execFileAsync, acquire, release } from '../../gh-utils'
export const MCODE_REPO = 'mcode-ide/mcode'

/**
 * Check if the authenticated user has starred the MCode repo.
 * Returns true if starred, false if not, null if unable to determine (gh unavailable).
 */
export async function checkMCodeStarred(): Promise<boolean | null> {
  await acquire()
  try {
    const { stdout, stderr } = await execFileAsync(
      'gh',
      ['api', '--include', `user/starred/${MCODE_REPO}`],
      { encoding: 'utf-8' }
    )
    const response = `${stdout ?? ''}\n${stderr ?? ''}`
    if (/HTTP\/\S+\s+(?:200|204)\b/.test(response)) {
      return true
    }
    return null
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 404 means the user hasn't starred — the only expected "no" answer
    if (message.includes('HTTP 404')) {
      return false
    }
    // Anything else (gh not installed, not authenticated, network issue)
    return null
  } finally {
    release()
  }
}

/**
 * Star the MCode repo for the authenticated user.
 */
export async function starMCode(): Promise<boolean> {
  await acquire()
  try {
    await execFileAsync('gh', ['api', '-X', 'PUT', `user/starred/${MCODE_REPO}`], {
      encoding: 'utf-8'
    })
    return true
  } catch {
    return false
  } finally {
    release()
  }
}
