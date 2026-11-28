/**
 * Each drive letter's last settled answer (the WSL share it maps to, or nowhere), kept across
 * launches. Background paths (the move prune, an unreadable journal's fence) only ever read these:
 * reading a mapped share can boot its stopped distro, so they never ask Windows themselves.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import { readNodeFileWithinLimit } from '../../../shared/file-content/node-bounded-file-reader'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../../filesystem/durable-file-write'
import {
  seedWslMappedDriveAnswers,
  setWslMappedDriveAnswerSink,
  wslMappedDriveAnswers,
  type WslMappedDriveAnswer
} from './wsl-mapped-drive-last-known'

const FILE_NAME = 'wsl-mapped-drive-answers.json'
const MAX_FILE_BYTES = 64 * 1024

const AnswersSchema = lazyZodSchema(() =>
  z.object({
    version: z.literal(1),
    answers: z
      .array(
        z.object({
          letter: z.string().regex(/^[A-Z]$/),
          share: z
            .string()
            .max(4_096)
            .refine((share) => parseWslUncPath(share) !== null)
            .nullable(),
          at: z.number().finite(),
          // Optional, and older builds strip keys they do not know, so either build reads the file.
          lookup: z.enum(['read', 'failed']).optional()
        })
      )
      .max(26)
  })
)

function sharesOf(answers: readonly WslMappedDriveAnswer[]): string {
  return JSON.stringify(
    [...answers]
      .sort((left, right) => left.letter.localeCompare(right.letter))
      .map(({ letter, share, lookup }) => [letter, share, lookup ?? null])
  )
}

export function wslMappedDriveAnswersPath(userDataPath: string): string {
  return join(userDataPath, FILE_NAME)
}

/**
 * Seeds the answers saved by earlier launches, then saves every new one. Reads only this file;
 * a missing or malformed file leaves every letter unknown.
 */
export async function loadWslMappedDriveAnswers(
  userDataPath: string
): Promise<{ saved: () => Promise<void> }> {
  const path = wslMappedDriveAnswersPath(userDataPath)
  try {
    // Seeding never overwrites an answer that settled while this read was in flight.
    const raw = (await readNodeFileWithinLimit(path, MAX_FILE_BYTES)).buffer.toString('utf8')
    const parsed = AnswersSchema.safeParse(JSON.parse(raw))
    if (parsed.success) {
      seedWslMappedDriveAnswers(parsed.data.answers)
    }
  } catch {
    // No answers saved yet, or unreadable: unknown letters stay unknown.
  }
  // A write that died before its rename leaves a temporary; another instance's is spared.
  let writing: Promise<void> = removeStaleDurableWriteTempFiles(path, {
    minimumAgeMs: 60_000
  }).catch(() => {})
  let pending: WslMappedDriveAnswer[] | null = null
  let savedShares = sharesOf(wslMappedDriveAnswers())
  setWslMappedDriveAnswerSink((answers) => {
    // Only where letters point and how it was learned count: a time-only change isn't worth a write.
    const shares = sharesOf(answers)
    if (shares === savedShares) {
      return
    }
    savedShares = shares
    // Writes run one at a time; a burst of answers saves only the newest set.
    const queued = pending !== null
    pending = answers
    if (queued) {
      return
    }
    writing = writing
      .then(async () => {
        const latest = pending ?? []
        pending = null
        const body = JSON.stringify({ version: 1, answers: latest })
        await writeFileDurable(durableWriteTempPath(path), path, body, 0o600)
      })
      .catch((error: unknown) => {
        console.warn('[wsl] Could not save mapped-drive answers:', error)
      })
  })
  return { saved: () => writing }
}
