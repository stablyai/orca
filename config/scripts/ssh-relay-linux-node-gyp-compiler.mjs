import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const NODE_CXX20_FLAG = "'-std=gnu++20',"
const GCC_8_CXX20_FLAG = "'-std=gnu++2a',"

export async function applySshRelayLinuxNodeGypCompilerFloor({ nodeRoot, tuple }) {
  if (!tuple.startsWith('linux-')) {
    return { changed: false }
  }
  const commonGypiPath = join(nodeRoot, 'include', 'node', 'common.gypi')
  const source = await readFile(commonGypiPath, 'utf8')
  const occurrences = source.split(NODE_CXX20_FLAG).length - 1
  if (occurrences !== 1) {
    throw new Error(`Expected exactly one Node Linux C++20 compiler flag, found ${occurrences}`)
  }
  // Why: GCC 8 names its C++20 draft mode gnu++2a; this preserves the oldest libstdc++ floor.
  await writeFile(commonGypiPath, source.replace(NODE_CXX20_FLAG, GCC_8_CXX20_FLAG))
  return { changed: true, commonGypiPath, standard: 'gnu++2a' }
}
