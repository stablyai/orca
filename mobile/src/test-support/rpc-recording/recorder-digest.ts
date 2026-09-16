import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { RECORDING_DRIVERS } from './recording-drivers'

export const RECORDER_DIRECTORY = 'mobile/src/test-support/rpc-recording'
/** The per-domain mount adapters. Excluded below and pinned per golden by `adapterSha256` instead. */
export const ADAPTER_DIRECTORY = `${RECORDER_DIRECTORY}/adapters`
/**
 * Mutant evidence. Excluded below and pinned by nothing: no recording ever reads it. Deliberately
 * not exported — an importable handle is a way for the recording path to name the directory without
 * spelling it, and `mutants/mutant-seam.test.ts` rejects both spellings.
 */
const MUTANT_DIRECTORY = `${RECORDER_DIRECTORY}/mutants`
const digests = new Map<string, string>()

function skippedTest(name: string): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: membership test on a readonly literal tuple, not a cast of the value.
  return name.endsWith('.test.ts') && !(RECORDING_DRIVERS as readonly string[]).includes(name)
}

function collect(root: string, relative: string, files: string[]): void {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1
  )) {
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      if (child !== ADAPTER_DIRECTORY && child !== MUTANT_DIRECTORY) {
        collect(root, child, files)
      }
    } else if (!entry.name.endsWith('.md') && !skippedTest(entry.name)) {
      files.push(child)
    }
  }
}

/**
 * Every executable recorder input a golden shares with every other golden: the engine, and nothing
 * domain-specific. Prose is excluded because it cannot change a recording; a candidate run
 * recomputes this and `compareGolden` fails the header, which forces an engine edit to re-record
 * deliberately.
 *
 * A suite that does not record is absent too, for the same reason the mutants are: it cannot put an
 * observation in a golden, so pinning it would claim a provenance the golden does not have.
 *
 * Three further inputs are deliberately absent. The scenario manifest used to be here, which made every
 * golden's header a function of every other family's scenarios; the mount adapters used to be here
 * too, which made it a function of every other family's adapter. `scenarioSha256` and
 * `adapterSha256` pin each golden to its own instead. The mutants are absent for a different
 * reason: nothing on the recording path reads them, so no edit there can change a recording, and
 * pinning them would claim a provenance the golden does not have. All three cost the same thing
 * when they were here — one domain's addition re-digested all 153 files and put a conflict on that
 * line in every domain branch in flight.
 */
export function recorderSha256(root: string): string {
  const cached = digests.get(root)
  if (cached !== undefined) {
    return cached
  }
  const files: string[] = []
  collect(root, RECORDER_DIRECTORY, files)
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
