/**
 * Decodes the RPC recording goldens at a base commit and in the working tree, and prints which
 * recorded behaviour moved: per golden, the checkpoint, the field and the JSON path, with both
 * values. The committed files are content-addressed JSON, so their raw diff is hashes.
 *
 *   pnpm --dir mobile rpc:diff [<base>] [--summary <file>]
 *
 * `<base>` defaults to the merge base with origin/main. `--summary` also appends a capped Markdown
 * report to that file (CI passes `$GITHUB_STEP_SUMMARY`). A behaviour change exits 0: this reports,
 * the recording suites judge. It exits non-zero only when git or a golden cannot be read.
 */
import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runProcess } from '@orca/process-host'
import { diffGoldenSets, formatChangeMarkdown, formatChangeText } from './rpc-diff-report.ts'
import {
  decodeGoldenFile,
  type DecodedGolden
} from '../src/test-support/rpc-recording/golden-difference.ts'

const GOLDENS = 'mobile/rpc-foundation/goldens'
// The corpus is ~16 MB; the default 8 MB capture would clip the batch read.
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024
const root = resolve(import.meta.dirname, '../..')

async function git(args: string[], input?: string): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args,
    cwd: root,
    input,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    timeoutMs: 120_000
  })
  if (result.code !== 0 || result.outputTruncated) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || 'output clipped'}`)
  }
  return result.stdout
}

function goldenId(path: string): string | null {
  const match = /([^/]+)\.json$/.exec(path)
  return match ? match[1]! : null
}

/** One `cat-file --batch` for the whole corpus rather than a process per golden. */
async function readBase(base: string): Promise<Map<string, DecodedGolden>> {
  const paths = (await git(['ls-tree', '-z', '--name-only', base, '--', `${GOLDENS}/`]))
    .split('\0')
    .filter((path) => path.endsWith('.json'))
  const goldens = new Map<string, DecodedGolden>()
  if (!paths.length) {
    return goldens
  }
  const batch = Buffer.from(
    await git(['cat-file', '--batch'], paths.map((path) => `${base}:${path}\n`).join(''))
  )
  let offset = 0
  for (const path of paths) {
    const newline = batch.indexOf(0x0a, offset)
    const header = batch.subarray(offset, newline).toString()
    const size = Number(header.split(' ')[2])
    if (!Number.isInteger(size)) {
      throw new Error(`Unexpected cat-file header for ${path}: ${header}`)
    }
    const body = batch.subarray(newline + 1, newline + 1 + size).toString()
    offset = newline + 1 + size + 1
    const id = goldenId(path)!
    goldens.set(id, decodeGoldenFile(JSON.parse(body), id))
  }
  return goldens
}

function readWorkingTree(): Map<string, DecodedGolden> {
  const directory = resolve(root, GOLDENS)
  const goldens = new Map<string, DecodedGolden>()
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const id = goldenId(file)!
    goldens.set(
      id,
      decodeGoldenFile(JSON.parse(readFileSync(resolve(directory, file), 'utf8')), id)
    )
  }
  return goldens
}

const argv = process.argv.slice(2)
const summaryAt = argv.indexOf('--summary')
const summary = summaryAt === -1 ? undefined : argv[summaryAt + 1]
if (summaryAt !== -1 && !summary) {
  throw new Error('--summary needs a file')
}
const positional = argv.filter(
  (_arg, index) => summaryAt === -1 || (index !== summaryAt && index !== summaryAt + 1)
)
if (positional.length > 1 || positional.some((arg) => arg.startsWith('-'))) {
  throw new Error('Usage: rpc-diff.mts [<base>] [--summary <file>]')
}
const base = positional[0] ?? (await git(['merge-base', 'origin/main', 'HEAD'])).trim()
const resolved = (await git(['rev-parse', '--verify', `${base}^{commit}`])).trim()
const set = diffGoldenSets(resolved, await readBase(resolved), readWorkingTree())
process.stdout.write(formatChangeText(set))
if (summary) {
  appendFileSync(summary, formatChangeMarkdown(set))
}
