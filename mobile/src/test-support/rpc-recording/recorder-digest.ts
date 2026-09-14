import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'

export const RECORDER_DIRECTORY = 'mobile/src/test-support/rpc-recording'
export const RECORDER_SCENARIO_INPUT = 'mobile/rpc-foundation/pilot-scenarios.json'
const digests = new Map<string, string>()

function collect(root: string, relative: string, files: string[]): void {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1
  )) {
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      collect(root, child, files)
    } else if (!entry.name.endsWith('.md')) {
      files.push(child)
    }
  }
}

/**
 * Every executable recorder input, so a golden is attributable to one runner and one scenario file.
 * Prose is excluded because it cannot change a recording; a candidate run recomputes this and
 * `compareGolden` fails the header, which forces a recorder edit to re-record deliberately.
 */
export function recorderSha256(root: string): string {
  const cached = digests.get(root)
  if (cached !== undefined) {
    return cached
  }
  const files: string[] = []
  collect(root, RECORDER_DIRECTORY, files)
  files.push(RECORDER_SCENARIO_INPUT)
  const digest = createHash('sha256')
    .update(
      files
        .map((file) => `${file}:${readFileSync(join(root, ...file.split(posix.sep)))}`)
        .join('\n')
    )
    .digest('hex')
  digests.set(root, digest)
  return digest
}
