import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_GLOBAL_FLAGS } from '../shared/cli-argument-boundary'
import { specPaths } from './command-spec'
import { COMMAND_SPECS } from './specs'

// Why: a guide is the version-matched surface for the binary that shipped it, so a command
// path or flag it names must exist in COMMAND_SPECS. `orca emulator camera --webcam` was
// documented for months without ever existing (#16904 review C1).

// Why __dirname: it works under both Vitest and the CommonJS tsc emit that build:cli type-checks
// this file against; import.meta.dirname does not (TS1470).
const projectDir = resolve(__dirname, '..', '..')
const guideRoot = join(projectDir, 'skill-guides')
const MAX_COMMAND_DEPTH = 3

type Invocation = { file: string; line: number; text: string }

function guideFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      return guideFiles(full)
    }
    return entry.isFile() && entry.name.endsWith('.md') ? [full] : []
  })
}

/**
 * The invocation span is the command text only — never the surrounding prose or table cell.
 * `skill-guides/orca-emulator.md` describes serve-sim's own `--detach` in a Notes column beside
 * an `ORCA ...` cell, and that is correct prose a line-scoped check would flag.
 */
function invocationSpans(contents: string, file: string): Invocation[] {
  const found: Invocation[] = []
  let inFence = false
  contents.split(/\r?\n/u).forEach((line, index) => {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence
      return
    }
    const spans = inFence ? [line] : [...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1])
    for (const span of spans) {
      const starts = [...span.matchAll(/\bORCA\b/gu)].map((match) => match.index)
      starts.forEach((start, position) => {
        found.push({
          file,
          line: index + 1,
          text: span.slice(start, starts[position + 1] ?? span.length).trim()
        })
      })
    }
  })
  return found
}

/** Blank out quoted values so a nested `--model` inside `--command "codex --model ..."` is not read as a flag. */
function maskQuotedValues(text: string): string {
  let masked = ''
  let quote: string | null = null
  for (const character of text) {
    if (quote) {
      masked += character === quote ? character : ' '
      if (character === quote) {
        quote = null
      }
    } else if (character === '"' || character === "'") {
      quote = character
      masked += character
    } else {
      masked += character
    }
  }
  return masked
}

const specByPath = new Map<string, (typeof COMMAND_SPECS)[number]>()
const pathPrefixes = new Set<string>()
for (const spec of COMMAND_SPECS) {
  for (const path of specPaths(spec)) {
    specByPath.set(path.join(' '), spec)
    for (let length = 1; length < path.length; length += 1) {
      pathPrefixes.add(path.slice(0, length).join(' '))
    }
  }
}

function longestKnownPrefix(tokens: string[]): string | null {
  for (let length = tokens.length; length >= 1; length -= 1) {
    const candidate = tokens.slice(0, length).join(' ')
    if (specByPath.has(candidate) || pathPrefixes.has(candidate)) {
      return candidate
    }
  }
  return null
}

function allowedFlagsFor(prefix: string): Set<string> {
  const exact = specByPath.get(prefix)
  const flags = new Set<string>(CLI_GLOBAL_FLAGS)
  const specs = exact
    ? [exact]
    : COMMAND_SPECS.filter((spec) =>
        specPaths(spec).some((path) => path.join(' ').startsWith(`${prefix} `))
      )
  for (const spec of specs) {
    for (const flag of spec.allowedFlags) {
      flags.add(flag)
    }
  }
  return flags
}

function describeFailure(invocation: Invocation, detail: string): string {
  const location = `${relative(projectDir, invocation.file)}:${invocation.line}`
  return `${location}: ${detail}\n    ${invocation.text}`
}

function parityFailures(invocation: Invocation): string[] {
  const masked = maskQuotedValues(invocation.text).replace(/\s#.*$/u, '')
  const tokens: string[] = []
  for (const token of masked.slice('ORCA'.length).trim().split(/\s+/u)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(token) || tokens.length === MAX_COMMAND_DEPTH) {
      break
    }
    tokens.push(token)
  }
  if (tokens.length === 0) {
    return []
  }

  const failures: string[] = []
  let command: string | null = null
  for (let length = tokens.length; length >= 1 && command === null; length -= 1) {
    const candidate = tokens.slice(0, length).join(' ')
    if (specByPath.has(candidate)) {
      command = candidate
    }
  }
  if (command === null) {
    // A prefix reference such as `ORCA emulator ...` or `ORCA linear --help` names no exact
    // path, but its flags still have to belong to some command under that prefix.
    if (pathPrefixes.has(tokens.join(' '))) {
      command = tokens.join(' ')
    }
  }
  if (command === null) {
    failures.push(
      describeFailure(invocation, `no COMMAND_SPECS path or alias for "${tokens.join(' ')}"`)
    )
    command = longestKnownPrefix(tokens)
    if (command === null) {
      return failures
    }
  }

  const allowed = allowedFlagsFor(command)
  for (const match of masked.matchAll(/--([a-z][a-z0-9-]*)/gu)) {
    if (!allowed.has(match[1])) {
      failures.push(describeFailure(invocation, `--${match[1]} is not a flag of "${command}"`))
    }
  }
  return failures
}

describe('skill guides only name commands and flags the CLI defines', () => {
  const invocations = guideFiles(guideRoot).flatMap((file) =>
    invocationSpans(readFileSync(file, 'utf8'), file)
  )

  it('extracts invocations from every guide and reference', () => {
    expect(invocations.length).toBeGreaterThan(150)
    expect(new Set(invocations.map((invocation) => invocation.file)).size).toBeGreaterThan(8)
  })

  it('resolves every ORCA invocation against COMMAND_SPECS', () => {
    expect(invocations.flatMap(parityFailures)).toEqual([])
  })

  it('checks flags on a prefix reference against every command under it', () => {
    const at = (text: string) => parityFailures({ file: 'x.md', line: 1, text })
    expect(at('ORCA emulator ...')).toEqual([])
    expect(at('ORCA linear --help')).toEqual([])
    expect(at('ORCA emulator --webcam')).toEqual([
      expect.stringContaining('--webcam is not a flag of "emulator"')
    ])
  })
})
