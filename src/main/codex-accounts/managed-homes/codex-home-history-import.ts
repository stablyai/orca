import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/errors/definitive-filesystem-absence'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { parseCodexRolloutThreadId } from '../../codex/history/rollouts/codex-rollout-thread-id'

export async function importCodexHomeHistory(
  sourceHome: string,
  destinationHome: string
): Promise<Map<string, string>> {
  if (parseWslUncPath(sourceHome) || parseWslUncPath(destinationHome)) {
    throw new Error('WSL history import is not supported yet. Import credentials only.')
  }
  const source = await realpath(resolve(sourceHome.trim()))
  const destination = await realpath(destinationHome)
  const offset = relative(source, destination)
  if (!offset || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))) {
    throw new Error('The imported account home must be outside the source home.')
  }
  const threads = new Map<string, string>()
  const copy = async (from: string, to: string): Promise<void> => {
    let entry
    try {
      entry = await lstat(from)
    } catch (error) {
      if (isDefinitiveAbsence(error)) {
        return
      }
      throw error
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        'This Codex history contains links. Choose a home with private session folders.'
      )
    }
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true })
      for (const child of await readdir(from)) {
        await copy(join(from, child), join(to, child))
      }
      return
    }
    if (!entry.isFile()) {
      throw new Error('Codex history contains an unsupported file type.')
    }
    await copyFile(from, to, constants.COPYFILE_EXCL)
    const rollout = parseCodexRolloutThreadId(from)
    if (rollout && (threads.get(rollout.threadId) ?? '') < rollout.rolloutStamp) {
      threads.set(rollout.threadId, rollout.rolloutStamp)
    }
  }
  for (const name of ['sessions', 'archived_sessions', 'session_index.jsonl', 'history.jsonl']) {
    await copy(join(source, name), join(destination, name))
  }
  return threads
}
