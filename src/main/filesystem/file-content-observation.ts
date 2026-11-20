import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { checkGuardedRead, recordGuardedPublication } from './concurrent-file-edit-guard'
import { fileIdentityKey as fileObservationKey } from './file-identity-key'

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
      const key = fileObservationKey(alias)
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
  const expected = observation.files.get(fileObservationKey(filePath))
  if (expected && expected.digest !== digest) {
    observation.matches = false
  }
}

export function observeFileContent(filePath: string, content: string | Uint8Array): void {
  checkGuardedRead(filePath, () => digestFileContent(content))
  const observation = observations.getStore()
  if (
    !observation?.open ||
    !observation.matches ||
    !observation.files.has(fileObservationKey(filePath))
  ) {
    return
  }
  observeFileDigest(filePath, digestFileContent(content))
}

export function observeFileReadError(filePath: string, error: unknown): void {
  if (isDefinitiveAbsence(error)) {
    checkGuardedRead(filePath, () => null)
  }
  const observation = observations.getStore()
  if (
    !observation?.open ||
    !observation.matches ||
    !observation.files.has(fileObservationKey(filePath))
  ) {
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
  if (
    observation?.open &&
    observation.matches &&
    observation.files.has(fileObservationKey(filePath))
  ) {
    observation.matches = false
  }
}

export function observeFilePublication(
  filePath: string,
  content: string | Uint8Array | null
): void {
  let digest: string | null | undefined
  // Why: most publications have no guard or observer; hash only for one that does.
  const publishedDigest = (): string | null =>
    (digest ??= content === null ? null : digestFileContent(content))
  recordGuardedPublication(filePath, publishedDigest)
  const observation = observations.getStore()
  if (!observation?.open || !observation.matches) {
    return
  }
  const expected = observation.files.get(fileObservationKey(filePath))
  if (expected) {
    expected.digest = publishedDigest()
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
    const expected = observation.files.get(fileObservationKey(filePath))
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

export type CapturedFileObservation = {
  files: ObservedFileContent[]
  paths: [string, string][]
}

/** The open scope's current expectations, for work that continues in another thread; null when none applies. */
export function captureFileObservation(): CapturedFileObservation | null {
  const observation = observations.getStore()
  if (!observation?.open || !observation.matches) {
    return null
  }
  const grouped = new Map<{ digest: string | null }, string[]>()
  for (const [key, entry] of observation.files) {
    const aliases = grouped.get(entry)
    if (aliases) {
      aliases.push(key)
    } else {
      grouped.set(entry, [key])
    }
  }
  return {
    files: [...grouped].map(([entry, aliases]) => ({ digest: entry.digest, aliases })),
    paths: [...observation.paths]
  }
}

/** Applies what a captured scope observed elsewhere: a mismatch fails this scope, publications advance it. */
export function adoptFileObservation(result: {
  matches: boolean
  files: readonly ObservedFileContent[]
}): void {
  const observation = observations.getStore()
  if (!observation?.open || !observation.matches) {
    return
  }
  if (!result.matches) {
    observation.matches = false
    return
  }
  for (const file of result.files) {
    for (const alias of file.aliases) {
      const expected = observation.files.get(fileObservationKey(alias))
      if (expected) {
        expected.digest = file.digest
      }
    }
  }
}

/** Runs `run` inside a scope seeded from a capture, returning what it observed for `adoptFileObservation`. */
export async function withCapturedFileObservation<T>(
  captured: CapturedFileObservation,
  run: () => T | Promise<T>
): Promise<{ value: T; matches: boolean; files: ObservedFileContent[] }> {
  let files: ObservedFileContent[] = []
  const result = await withFileContentObservation(
    captured.files,
    new Map(captured.paths),
    async () => {
      const value = await run()
      files = captureFileObservation()?.files ?? []
      return value
    }
  )
  return { ...result, files }
}
