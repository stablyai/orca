// The committed readiness census: run-length-encoded verdicts per frame, compared or rewritten.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UPDATE_CENSUS_ENV = 'UPDATE_READINESS_CENSUS'
const BASELINE_DIR = join(__dirname, '__fixtures__', 'readiness-census')

/** Per pane (or matrix row group), one observation per frame (or case). */
export type CensusObservations = Record<string, readonly string[]>

/** One committed baseline file: per-frame observations, or named synthetic cases. */
type CensusBaselineFile = { description: string } & (
  | {
      /** Lines of `<first>-<last>: <observation>`, or `<index>: <observation>` for one frame. */
      observations: Record<string, string[]>
    }
  | { cases: Record<string, string> }
)

export function runLengthEncode(values: readonly string[]): string[] {
  const lines: string[] = []
  let start = 0
  for (let index = 1; index <= values.length; index += 1) {
    if (index < values.length && values[index] === values[start]) {
      continue
    }
    const range = index - 1 === start ? `${start}` : `${start}-${index - 1}`
    lines.push(`${range}: ${values[start]}`)
    start = index
  }
  return lines
}

export function runLengthDecode(lines: readonly string[]): string[] {
  const values: string[] = []
  for (const line of lines) {
    const match = /^(\d+)(?:-(\d+))?: (.*)$/.exec(line)
    if (!match) {
      throw new Error(`malformed census line: ${line}`)
    }
    const first = Number(match[1])
    const last = match[2] === undefined ? first : Number(match[2])
    for (let index = first; index <= last; index += 1) {
      values.push(match[3])
    }
  }
  return values
}

function baselinePath(subject: string): string {
  return join(BASELINE_DIR, `${subject.replaceAll('/', '--')}.json`)
}

/** Readable per-index differences, grouped into runs so a shifted lane reads as one line. */
export function describeCensusDiff(
  subject: string,
  expected: CensusObservations,
  actual: CensusObservations
): string[] {
  const out: string[] = []
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const was = expected[key] ?? []
    const now = actual[key] ?? []
    if (was.length !== now.length) {
      out.push(`${subject} ${key}: ${was.length} entries in the baseline, ${now.length} now`)
    }
    let runStart = -1
    const flush = (end: number): void => {
      if (runStart === -1) {
        return
      }
      const range = end === runStart ? `${runStart}` : `${runStart}-${end}`
      out.push(
        `${subject} ${key} [${range}]:\n    was: ${was[runStart] ?? '(none)'}\n    now: ${now[runStart] ?? '(none)'}`
      )
      runStart = -1
    }
    const length = Math.max(was.length, now.length)
    for (let index = 0; index < length; index += 1) {
      const differs = was[index] !== now[index]
      const continuesRun =
        differs && runStart !== -1 && was[index] === was[runStart] && now[index] === now[runStart]
      if (continuesRun) {
        continue
      }
      flush(index - 1)
      if (differs) {
        runStart = index
      }
    }
    flush(length - 1)
  }
  return out
}

const REGENERATE_HINT = `  ${UPDATE_CENSUS_ENV}=1 pnpm test src/main/runtime/readiness-census`

/** Writes `next` when regenerating; otherwise returns the stored baseline's `field`, or a failure. */
function readOrWriteBaseline(
  subject: string,
  field: 'observations' | 'cases',
  next: CensusBaselineFile
): { stored: Record<string, unknown> } | { message: string } {
  const path = baselinePath(subject)
  if (process.env[UPDATE_CENSUS_ENV] === '1') {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`)
    return { message: '' }
  }
  if (!existsSync(path)) {
    return { message: `${subject}: no baseline at ${path}; record one with\n${REGENERATE_HINT}` }
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const stored: unknown =
    typeof parsed === 'object' && parsed !== null
      ? new Map(Object.entries(parsed)).get(field)
      : undefined
  if (typeof stored !== 'object' || stored === null) {
    return { message: `${subject}: baseline at ${path} has no ${field}` }
  }
  return { stored: Object.fromEntries(Object.entries(stored)) }
}

function formatFailure(diff: readonly string[]): string {
  return diff.length === 0
    ? ''
    : [
        `Readiness verdicts changed (${diff.length} runs). If intended, regenerate with`,
        REGENERATE_HINT,
        ...diff
      ].join('\n')
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line) => typeof line === 'string')
}

/**
 * Compares per-frame `actual` to the committed baseline, or rewrites it when
 * UPDATE_READINESS_CENSUS=1. Returns the readable diff; empty means unchanged.
 */
export function checkCensusBaseline(
  subject: string,
  description: string,
  actual: CensusObservations
): string {
  const observations = Object.fromEntries(
    Object.entries(actual).map(([key, values]) => [key, runLengthEncode(values)])
  )
  const read = readOrWriteBaseline(subject, 'observations', { description, observations })
  if ('message' in read) {
    return read.message
  }
  const expected: Record<string, string[]> = {}
  for (const [key, lines] of Object.entries(read.stored)) {
    if (!isStringList(lines)) {
      return `${subject}: baseline ${key} is not a list of lines`
    }
    expected[key] = runLengthDecode(lines)
  }
  return formatFailure(describeCensusDiff(subject, expected, actual))
}

/** The same, for named cases rather than frames. */
export function checkCensusCases(
  subject: string,
  description: string,
  actual: Record<string, string>
): string {
  const read = readOrWriteBaseline(subject, 'cases', { description, cases: actual })
  if ('message' in read) {
    return read.message
  }
  const diff: string[] = []
  for (const key of new Set([...Object.keys(read.stored), ...Object.keys(actual)])) {
    const was = read.stored[key]
    const now = actual[key]
    if (was !== now) {
      diff.push(
        `${subject} ${key}:\n    was: ${typeof was === 'string' ? was : '(none)'}\n    now: ${now ?? '(none)'}`
      )
    }
  }
  return formatFailure(diff)
}
