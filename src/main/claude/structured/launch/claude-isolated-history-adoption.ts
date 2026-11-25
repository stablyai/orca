import { copyFile, cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { ClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-router'
import { resolveSessionFilePath } from '../../../native-chat/session-file-resolver'

/** Rename keeps it atomic on one volume; another volume copies under a staging name first, so
 *  the target never appears half-written. */
async function moveEntry(source: string, target: string): Promise<void> {
  try {
    await rename(source, target)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) {
      throw error
    }
    const isDirectory = (await stat(source)).isDirectory()
    const staging = `${target}.orca-partial`
    await rm(staging, { recursive: true, force: true })
    await (isDirectory ? cp(source, staging, { recursive: true }) : copyFile(source, staging))
    await rename(staging, target)
    await rm(source, { recursive: true, force: true })
  }
}

/**
 * A chat created on an account whose history was later separated still has its transcript in
 * System default's shared history. Moves it (and its subagent folder) into the account's own
 * history so the chat resumes there. Only a chat founded on that same account moves: one from
 * another account is never taken.
 */
export async function adoptClaudeTranscriptIntoIsolatedAccount(input: {
  router: Pick<ClaudeProfileRouter, 'savedAccount' | 'accountHome' | 'systemDefaultHome'>
  providerSessionId: string
  claudeConfigDir: string
  recordHome: string
  cwd?: string
}): Promise<boolean> {
  const { router, claudeConfigDir } = input
  // An account folder is <dataRoot>/claude-profiles/<accountId>/home.
  const accountId = basename(dirname(claudeConfigDir))
  if (
    input.recordHome !== claudeConfigDir ||
    !router.savedAccount(accountId)?.historyIsolated ||
    router.accountHome(accountId) !== claudeConfigDir
  ) {
    return false
  }
  const source = await resolveSessionFilePath('claude', input.providerSessionId, {
    claudeProjectsDir: join(router.systemDefaultHome(), 'projects'),
    cwd: input.cwd
  })
  if (!source) {
    return false
  }
  const bucket = join(claudeConfigDir, 'projects', basename(dirname(source)))
  await mkdir(bucket, { recursive: true, mode: 0o700 })
  // Why: the transcript moves last because the launch takes it as proof the move finished; a
  // failure before then leaves it shared and the next launch retries the whole move.
  const subagents = source.replace(/\.jsonl$/, '')
  if ((await stat(subagents).catch(() => null))?.isDirectory()) {
    await moveEntry(subagents, join(bucket, basename(subagents)))
  }
  await moveEntry(source, join(bucket, basename(source)))
  return true
}
