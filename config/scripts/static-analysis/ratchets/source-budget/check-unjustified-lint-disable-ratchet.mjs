import process from 'node:process'
import ts from 'typescript-api'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'

// A lint suppression must say why; counts per file may only go down.

const BASELINE_PATH = 'config/unjustified-lint-disable-baseline.txt'
const SCAN_PATHSPECS = ['src/*.ts', 'src/*.tsx', 'src/*.mts', 'src/*.cts']
const DISABLE_DIRECTIVE = /(?:eslint|oxlint)-disable(?:-next-line|-line)?\b([^\n]*)/g

// Cheap pre-filter: most files never mention a directive, so skip the parse.
const DIRECTIVE_WORD = /(?:eslint|oxlint)-disable/

export function isScannedPath(rel) {
  return !/\.(?:test|spec)\.[cm]?tsx?$/.test(rel)
}

// Comment text only: a directive-looking string, template or regex literal is not one.
function commentTexts(sourceText, relPath) {
  const ast = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, false)
  const seen = new Set()
  const texts = []
  const collect = (ranges) => {
    for (const { pos, end } of ranges ?? []) {
      if (!seen.has(pos)) {
        seen.add(pos)
        texts.push(sourceText.slice(pos, end))
      }
    }
  }
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(sourceText, node.getFullStart()))
    collect(ts.getTrailingCommentRanges(sourceText, node.end))
    for (const child of node.getChildren(ast)) {
      visit(child)
    }
  }
  visit(ast)
  return texts
}

// A directive is justified when ` -- <reason>` follows the rule list.
// relPath picks the script kind from its extension (`<T>(x)` is a generic in .ts, JSX in .tsx); defaults to TSX.
export function countUnjustifiedDisables(sourceText, relPath = 'file.tsx') {
  if (!DIRECTIVE_WORD.test(sourceText)) {
    return 0
  }
  let count = 0
  for (const comment of commentTexts(sourceText, relPath)) {
    for (const [, rest] of comment.matchAll(DISABLE_DIRECTIVE)) {
      const reason = rest
        .split('*/')[0]
        .split(/\s--\s/)[1]
        ?.trim()
      if (!reason) {
        count += 1
      }
    }
  }
  return count
}

export function collectUnjustifiedDisableCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_PATHSPECS, isScannedPath)) {
    const count = countUnjustifiedDisables(source, rel)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'unjustified-lint-disable',
      baselinePath: BASELINE_PATH,
      header: [
        '# eslint/oxlint-disable directives without a ` -- <reason>` in production src, per file.',
        '# This is a RATCHET: counts may only go DOWN.',
        '# Prune after adding reasons: pnpm check:unjustified-lint-disable-ratchet --prune'
      ],
      collect: collectUnjustifiedDisableCounts,
      unit: 'unjustified lint disable(s)',
      fix: [
        'Append the reason to the directive, e.g. `// oxlint-disable-next-line <rule> -- SAFETY: <why>`.',
        'Better: fix the code so the suppression is not needed.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
