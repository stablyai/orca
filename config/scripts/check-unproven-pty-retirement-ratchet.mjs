import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'

// Ratchet on PTY retirements that rest on no exit proof (src/main/pty-exit-proof.ts): unproven
// ones, and ownership drops outside `finishPtyShutdown`, which name no evidence at all. Each drops
// the handle a later stop could use while the process may still run. Counts may only go down.

const BASELINE_PATH = 'config/unproven-pty-retirement-baseline.txt'
const SCAN_ROOTS = ['src']
const UNPROVEN_RETIREMENT = /\bPtyRetirementWithoutProof\.because\(|\bptyOwnership\.delete\(/g
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm

export function isScannedPath(rel) {
  return (
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !/(?:^|[/.-])(?:test-fixture|test-support|test-harness|fixtures?)(?:[/.-]|$)|__fixtures__/.test(
      rel
    ) &&
    // The one evidence-taking ownership drop.
    rel !== 'src/main/ipc/pty/provider/liveness.ts'
  )
}

export function countUnprovenPtyRetirements(sourceText) {
  return sourceText.replace(COMMENT, ' ').match(UNPROVEN_RETIREMENT)?.length ?? 0
}

export function collectUnprovenPtyRetirementCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countUnprovenPtyRetirements(source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'unproven-pty-retirement',
      baselinePath: BASELINE_PATH,
      header: [
        '# PTY retirements on no exit proof per file: PtyRetirementWithoutProof.because, and raw',
        '# ptyOwnership.delete outside finishPtyShutdown. This is a RATCHET: counts may only go DOWN.',
        '# Retire through finishPtyShutdown on a PtyExitProof, or record the stop durably first.',
        '# Prune after a fix: pnpm check:unproven-pty-retirement-ratchet --prune'
      ],
      collect: collectUnprovenPtyRetirementCounts,
      unit: 'unproven PTY retirement(s)',
      fix: [
        'Retire a PTY through finishPtyShutdown on a PtyExitProof (src/main/pty-exit-proof.ts), or',
        'keep its ownership until one arrives. A close the host cannot answer must read unverifiable.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
