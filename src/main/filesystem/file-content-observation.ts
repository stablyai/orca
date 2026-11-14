import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'

export type ObservedFileContent = {
  digest: string | null
  aliases: readonly string[]
}

type Observation = {
  files: Map<string, { digest: string | null }>
  paths: Map<string, string>
  matches: boolean
  open: boolean
}

const observations = new AsyncLocalStorage<Observation>()

function fileKey(filePath: string): string {
  const absolute = resolve(filePath)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function digestFileContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function withFileContentObservation<T>(
  files: readonly ObservedFileContent[],
  paths: ReadonlyMap<string, string>,
  run: (isStillValid: () => boolean) => Promise<T>
): Promise<{ value: T; matches: boolean }> {
  const expected = new Map<string, { digest: string | null }>()
  for (const file of files) {
    const entry = { digest: file.digest }
    for (const alias of file.aliases) {
      const key = fileKey(alias)
      if (expected.has(key)) {
        // Ambiguous aliases cannot prove which file an operation processed.
        return { value: await run(() => false), matches: false }
      }
      expected.set(key, entry)
    }
  }
  const observation: Observation = {
    files: expected,
    paths: new Map(paths),
    matches: true,
    open: true
  }
  return observations.run(observation, async () => {
    try {
      const value = await run(() => observation.open && observation.matches)
      return { value, matches: observation.matches }
    } finally {
      observation.open = false
      observation.files.clear()
      observation.paths.clear()
    }
  })
}

export function observeFileDigest(filePath: string, digest: string | null): void {
  const observation = observations.getStore()
  if (!observation?.open || !observation.matches) {
    return
  }
  const expected = observation.files.get(fileKey(filePath))
  if (expected && expected.digest !== digest) {
    observation.matches = false
  }
}

export function observeFileContent(filePath: string, content: string | Uint8Array): void {
  const observation = observations.getStore()
  if (!observation?.open || !observation.matches || !observation.files.has(fileKey(filePath))) {
    return
  }
  observeFileDigest(filePath, digestFileContent(content))
}

export function observeFileReadError(filePath: string, error: unknown): void {
  const observation = observations.getStore()
  if (!observation?.open || !observation.matches || !observation.files.has(fileKey(filePath))) {
    return
  }
  if (isDefinitiveAbsence(error)) {
    observeFileDigest(filePath, null)
  } else {
    observation.matches = false
  }
}

export function invalidateFileObservation(filePath: string): void {
  const observation = observations.getStore()
  if (observation?.open && observation.matches && observation.files.has(fileKey(filePath))) {
    observation.matches = false
  }
}

export function observeFilePublication(
  filePath: string,
  content: string | Uint8Array | null
): void {
  const observation = observations.getStore()
  if (!observation?.open || !observation.matches) {
    return
  }
  const expected = observation.files.get(fileKey(filePath))
  if (expected) {
    expected.digest = content === null ? null : digestFileContent(content)
  }
}

export function observeResolvedFilePath(kind: string, input: string, resolved: string): string {
  const observation = observations.getStore()
  if (!observation?.open || !observation.matches) {
    return resolved
  }
  const expected = observation.paths.get(`${kind}\0${input}`)
  if (expected !== undefined && expected !== resolved) {
    observation.matches = false
  }
  return resolved
}

export function observeResolvedFilePathError(kind: string, input: string, error: unknown): void {
  const observation = observations.getStore()
  if (
    observation?.open &&
    observation.matches &&
    observation.paths.has(`${kind}\0${input}`) &&
    !isDefinitiveAbsence(error)
  ) {
    observation.matches = false
  }
}

export function observedExistsSync(filePath: string): boolean {
  const present = existsSync(filePath)
  const observation = observations.getStore()
  if (observation?.open && observation.matches) {
    const expected = observation.files.get(fileKey(filePath))
    if (expected && present !== (expected.digest !== null)) {
      observation.matches = false
    }
  }
  return present
}

export function readObservedFileSync(filePath: string): Buffer
export function readObservedFileSync(filePath: string, encoding: 'utf-8' | 'utf8'): string
export function readObservedFileSync(
  filePath: string,
  encoding?: 'utf-8' | 'utf8'
): string | Buffer {
  try {
    const content = encoding ? readFileSync(filePath, encoding) : readFileSync(filePath)
    observeFileContent(filePath, content)
    return content
  } catch (error) {
    observeFileReadError(filePath, error)
    throw error
  }
}
