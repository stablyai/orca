import { link, lstat, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveSessionFilePath } from '../../native-chat/session-file-resolver'
import { errnoCodeOrUnknown } from '../../../shared/errors/errno-code'

/** Like Codex's launch-time move, bring saved context into the selected account before resume. */
export async function moveClaudeSessionIntoAccountHome(args: {
  providerSessionId: string
  fromHome: string
  toHome: string
  cwd?: string
}): Promise<void> {
  const find = (home: string) =>
    resolveSessionFilePath('claude', args.providerSessionId, {
      claudeProjectsDir: join(home, 'projects'),
      cwd: args.cwd,
      strictErrors: true
    })
  if (await find(args.toHome)) {
    return
  }
  const source = await find(args.fromHome)
  if (!source) {
    return
  }
  // Keep Claude's project bucket and session id. Never share credentials or a whole account folder.
  const directory = join(args.toHome, 'projects', basename(dirname(source)))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // The resolver deliberately ignores symlinked buckets, even when their files are readable.
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error('The Claude target project bucket is not a real directory.')
  }
  const destination = join(directory, basename(source))
  try {
    // One file in both homes: an old process's later appends remain visible to the resumed chat.
    await link(source, destination)
  } catch (error) {
    if (errnoCodeOrUnknown(error) !== 'EEXIST') {
      throw error
    }
    const [before, after] = await Promise.all([lstat(source), lstat(destination)])
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('A different Claude transcript occupies the target path.', { cause: error })
    }
  }
  if (!(await find(args.toHome))) {
    throw new Error('The Claude transcript is not resumable in the selected account.')
  }
}
