import { renameSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AntigravityChatSignInIntent } from '../../shared/antigravity-account-types'
import { acpRunFolder } from '../acp/acp-private-temp'
import { removeAntigravitySignInSessionFiles } from './antigravity-sign-in-session-files'

export async function antigravitySignInHome(home: string, intent: AntigravityChatSignInIntent) {
  // A failed or orphaned replacement must never write the working account's credentials.
  const stage = intent === 'changeAccount' ? await acpRunFolder(join(home, 'sign-in')) : null
  const cwd = stage
    ? join(stage.path, 'workspace')
    : await mkdtemp(join(tmpdir(), 'orca-antigravity-sign-in-'))
  try {
    if (stage) {
      await mkdir(cwd)
    }
  } catch (error) {
    await stage?.remove()
    throw error
  }
  return {
    home: stage ? join(stage.path, 'home') : home,
    cwd,
    replacement: stage !== null,
    remove: (sessionId: string): Promise<void> =>
      stage
        ? stage.remove()
        : Promise.all([
            removeAntigravitySignInSessionFiles(home, sessionId, cwd),
            rm(cwd, { recursive: true, force: true })
          ]).then(
            () => {},
            (error: unknown) => {
              console.warn('[antigravity] sign-in session files not removed:', error)
            }
          )
  }
}

/** Validate before the final cancellation check, then commit and publish without yielding. */
export async function antigravitySignInCredentialCommit(
  stageHome: string,
  home: string
): Promise<() => void> {
  const token = join(stageHome, 'antigravity-acp', 'acp_token.json')
  const saved = await lstat(token)
  if (!saved.isFile() || saved.size === 0) {
    throw new Error('Antigravity did not save a replacement Chat credential.')
  }
  await chmod(token, 0o600)
  return () => renameSync(token, join(home, 'antigravity-acp', 'acp_token.json'))
}
