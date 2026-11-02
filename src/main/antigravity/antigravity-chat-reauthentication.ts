import { lstat, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

function tokenPaths(home: string) {
  const token = join(home, 'antigravity-acp', 'acp_token.json')
  return { token, backup: `${token}.orca-sign-in-backup` }
}

async function hasToken(path: string): Promise<boolean> {
  const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (file && !file.isFile()) {
    throw new Error('Antigravity chat credential is not a regular file.')
  }
  return file !== null
}

/** Recover an interrupted switch only after the previous credential writer has stopped. */
export async function recoverAntigravityChatToken(home: string): Promise<void> {
  const { token, backup } = tokenPaths(home)
  if (await hasToken(backup)) {
    await hasToken(token)
    await rename(backup, token)
  }
}

/** The ACP server otherwise treats authenticate as a no-op when its token is still valid. */
export async function prepareAntigravityChatReauthentication(
  home: string
): Promise<(signedIn: boolean) => Promise<void>> {
  await recoverAntigravityChatToken(home)
  const { token, backup } = tokenPaths(home)
  const saved = await hasToken(token)
  if (saved) {
    await rename(token, backup)
  }
  return async (signedIn) => {
    if (signedIn) {
      await rm(backup, { force: true })
    } else if (saved) {
      await rename(backup, token)
    } else {
      await rm(token, { force: true })
    }
  }
}
