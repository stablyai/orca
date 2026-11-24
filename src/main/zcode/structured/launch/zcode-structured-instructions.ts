// ZCode takes standing instructions from no channel of its own: it reads the folder's AGENTS.md into
// its prompt each time a session starts, a resumed one included, and again after each compaction; a
// running session keeps what it read until then (checked live on ZCode 4.0.0). Every launch rewrites
// the file with the current text. It is the one instructions file ZCode reads in a folder, and other
// agents read AGENTS.md too: a chat on one of those in the same bot's home reads this copy as well
// as the instructions its own launch passes it.
import { writeFolderContextFile } from '../../../acp/launch/acp-folder-context-file'

// The most ZCode reads of one instructions file; past it the rest is cut off, not refused (checked
// live on ZCode 4.0.0: a marker past that byte never reaches the model).
const ZCODE_INSTRUCTIONS_FILE_MAX_BYTES = 100 * 1024

const NOT_WRITTEN =
  "Orca couldn't write this chat's instructions into the folder's AGENTS.md, which is where ZCode reads them, so it did not start without them."

/**
 * Writes `text` as Orca's part of `cwd`'s AGENTS.md. Throws when ZCode would not read all of it: a
 * link in the way, or a file past its limit, since a chat that lost part of its rules must not run.
 */
export async function writeZcodeInstructions(cwd: string, text: string): Promise<void> {
  const bytes = await writeFolderContextFile(cwd, 'AGENTS.md', 'ZCode', text)
  if (bytes === null) {
    throw new Error(NOT_WRITTEN)
  }
  if (bytes > ZCODE_INSTRUCTIONS_FILE_MAX_BYTES) {
    throw new Error(
      `ZCode reads only the first ${ZCODE_INSTRUCTIONS_FILE_MAX_BYTES / 1024} KB of the folder's AGENTS.md, and the one in ${cwd} is larger, so this chat's instructions would be cut off. Shorten that file; the chat did not start without them.`
    )
  }
}
