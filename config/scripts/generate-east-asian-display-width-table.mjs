// Why: the column-width table must agree with what Orca's terminals actually
// render, and a hand-maintained range list drifts from it. Generate the table
// from the same @xterm/addon-unicode11 provider the renderer activates, so CLI
// and SSH table alignment cannot disagree with the terminal.
//
//   node config/scripts/generate-east-asian-display-width-table.mjs
//   node config/scripts/generate-east-asian-display-width-table.mjs --check
//
// --check exits non-zero when the committed table is stale, so CI catches an
// xterm bump that moves a width.

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const projectDir = resolve(import.meta.dirname, '..', '..')
const requireFromProject = createRequire(join(projectDir, 'package.json'))
const OUTPUT_PATH = join(projectDir, 'src', 'shared', 'east-asian-display-width-table.ts')

const MAX_CODE_POINT = 0x10ffff
const SURROGATE_START = 0xd800
const SURROGATE_END = 0xdfff

async function loadUnicode11Provider() {
  const addonPath = requireFromProject.resolve('@xterm/addon-unicode11')
  // Why: a hand-built `file://` string mis-parses a Windows drive letter as the
  // URL host and leaves spaces unencoded; pathToFileURL handles both.
  const module = await import(pathToFileURL(addonPath).href)
  const Addon = module.Unicode11Addon ?? module.default?.Unicode11Addon ?? module.default
  let provider = null
  new Addon().activate({
    unicode: {
      register: (registered) => {
        provider = registered
      },
      activeVersion: ''
    }
  })
  if (!provider) {
    throw new Error('@xterm/addon-unicode11 did not register a Unicode version provider')
  }
  return provider
}

/**
 * Both width classes in a single pass. This script runs on every `pnpm lint`,
 * so the 1.1M-code-point sweep is walked once and `wcwidth` is asked once per
 * code point rather than once per class.
 */
function collectWidthRanges(provider) {
  const targets = [0, 2]
  const ranges = new Map(targets.map((target) => [target, []]))
  const openStart = new Map(targets.map((target) => [target, null]))

  for (let codePoint = 0; codePoint <= MAX_CODE_POINT; codePoint += 1) {
    // Why: lone surrogates are not characters; probing them would split a range
    // that is otherwise contiguous across the gap.
    const isSurrogate = codePoint >= SURROGATE_START && codePoint <= SURROGATE_END
    const width = isSurrogate ? -1 : provider.wcwidth(codePoint)
    for (const target of targets) {
      const start = openStart.get(target)
      if (width === target && start === null) {
        openStart.set(target, codePoint)
      } else if (width !== target && start !== null && !isSurrogate) {
        ranges.get(target).push([start, codePoint - 1])
        openStart.set(target, null)
      }
    }
  }

  for (const target of targets) {
    const start = openStart.get(target)
    if (start !== null) {
      ranges.get(target).push([start, MAX_CODE_POINT])
    }
  }
  return { zeroRanges: ranges.get(0), doubleRanges: ranges.get(2) }
}

// Why: fill to the formatter's print width so regenerating is a no-op instead
// of fighting oxfmt over the wrapping on every run.
const PRINT_WIDTH = 100
const INDENT = '  '

function formatRanges(ranges) {
  const numbers = ranges.flat().map((value) => `0x${value.toString(16)}`)
  const lines = []
  let current = []
  for (const number of numbers) {
    const candidate = [...current, number]
    if (current.length > 0 && `${INDENT}${candidate.join(', ')},`.length > PRINT_WIDTH) {
      lines.push(`${INDENT}${current.join(', ')},`)
      current = [number]
      continue
    }
    current = candidate
  }
  if (current.length > 0) {
    lines.push(`${INDENT}${current.join(', ')}`)
  }
  return lines.join('\n')
}

function parseCommittedRanges(source, exportName) {
  const match = source.match(new RegExp(`${exportName}: readonly number\\[\\] = \\[([^\\]]*)\\]`))
  if (!match) {
    throw new Error(`${exportName} was not found in ${OUTPUT_PATH}`)
  }
  return match[1]
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number(entry))
}

function renderFile(provider, zeroRanges, doubleRanges) {
  const version = requireFromProject('@xterm/addon-unicode11/package.json').version
  return `// GENERATED FILE — do not edit by hand.
// Regenerate: node config/scripts/generate-east-asian-display-width-table.mjs
//
// Source: @xterm/addon-unicode11 ${version}, Unicode version "${provider.version}" —
// the same provider Orca's terminals activate, so CLI and SSH column alignment
// cannot disagree with what the terminal renders.
//
// Each array is flattened inclusive [start, end] code point pairs, ascending.

/** Code points that advance the cursor by no columns. */
export const ZERO_WIDTH_CODE_POINT_RANGES: readonly number[] = [
${formatRanges(zeroRanges)}
]

/** Code points that advance the cursor by two columns. */
export const DOUBLE_WIDTH_CODE_POINT_RANGES: readonly number[] = [
${formatRanges(doubleRanges)}
]
`
}

async function main() {
  const provider = await loadUnicode11Provider()
  const { zeroRanges, doubleRanges } = collectWidthRanges(provider)

  if (process.argv.includes('--check')) {
    // Why: compare the code points rather than the file bytes, so oxfmt owning
    // the line wrapping cannot make a correct table look stale.
    const committed = readFileSync(OUTPUT_PATH, 'utf8')
    const expected = {
      ZERO_WIDTH_CODE_POINT_RANGES: zeroRanges.flat(),
      DOUBLE_WIDTH_CODE_POINT_RANGES: doubleRanges.flat()
    }
    for (const [exportName, values] of Object.entries(expected)) {
      const actual = parseCommittedRanges(committed, exportName)
      const matches = actual.length === values.length && actual.every((v, i) => v === values[i])
      if (!matches) {
        console.error(
          `${exportName} is stale (${actual.length} vs ${values.length} entries). Run: node config/scripts/generate-east-asian-display-width-table.mjs`
        )
        process.exit(1)
      }
    }
    console.log('east-asian-display-width table OK — matches @xterm/addon-unicode11.')
    return
  }

  writeFileSync(OUTPUT_PATH, renderFile(provider, zeroRanges, doubleRanges))
  console.log(`Wrote ${OUTPUT_PATH}`)
}

await main()
