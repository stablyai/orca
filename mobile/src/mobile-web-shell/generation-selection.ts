import { z } from 'zod'
import { joinUri } from './generation-cache-uri'
import type { GenerationFileSystem } from './generation-store-file-system'

const BuildId = z.string().regex(/^[a-f0-9]{64}$/)
const SelectionSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  confirmed: BuildId.nullable(),
  pending: BuildId.nullable(),
  rejected: BuildId.nullable()
})

export type GenerationSelection = z.infer<typeof SelectionSchema>
export type GenerationSelectionLog = {
  readonly records: readonly GenerationSelection[]
  readonly nextRevision: number
  readonly exists: boolean
}

const directory = (root: string): string => joinUri(root, 'activation')
const filename = (revision: number): string => `${String(revision).padStart(16, '0')}.json`

export async function readGenerationSelections(
  fs: GenerationFileSystem,
  root: string
): Promise<GenerationSelectionLog> {
  const entries = await fs.list(directory(root))
  const names = entries
    .map((entry) => entry.name)
    .filter((name) => /^\d{16}\.json$/.test(name))
    .sort((left, right) => right.localeCompare(left))
  const records: GenerationSelection[] = []
  for (const name of names) {
    const text = await fs.readText(joinUri(directory(root), name))
    try {
      const parsed = SelectionSchema.safeParse(JSON.parse(text ?? 'null'))
      if (parsed.success && filename(parsed.data.revision) === name) {
        records.push(parsed.data)
      }
    } catch {
      // An interrupted append cannot invalidate an earlier complete selection.
    }
  }
  return {
    records,
    nextRevision: names.length === 0 ? 0 : Number(names[0].slice(0, 16)) + 1,
    exists: (await fs.list(root)).some((entry) => entry.name === 'activation')
  }
}

// Expo offers no fsync contract: append without overwriting authority, then verify process-visible publication.
export async function appendGenerationSelection(
  fs: GenerationFileSystem,
  root: string,
  log: GenerationSelectionLog,
  selection: Omit<GenerationSelection, 'version' | 'revision'>
): Promise<GenerationSelection> {
  const record = SelectionSchema.parse({ ...selection, version: 1, revision: log.nextRevision })
  const path = joinUri(directory(root), filename(record.revision))
  const text = JSON.stringify(record)
  try {
    await fs.writeText(path, text)
    if ((await fs.readText(path)) !== text) {
      throw new Error('generation selection did not publish completely')
    }
    return record
  } catch (error) {
    await fs.delete(path).catch(() => undefined)
    throw error
  }
}

export async function compactGenerationSelections(
  fs: GenerationFileSystem,
  root: string,
  records: readonly GenerationSelection[]
): Promise<void> {
  const kept = new Set(records.slice(0, 2).map((record) => filename(record.revision)))
  for (const entry of await fs.list(directory(root))) {
    if (!kept.has(entry.name)) {
      await fs.delete(joinUri(directory(root), entry.name))
    }
  }
}
