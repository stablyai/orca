// Guard: a branch must not drop work that is already reachable from its own merge base.
//
// Building a branch by checking out whole files from an older stack (instead of merging) silently
// reverts shipped fixes. Typecheck and tests cannot see it — a reverted feature still compiles, and
// its old tests still pass — so this compares, for every file both sides touched since the merge
// base, whether lines the base branch added are missing from the topic branch.
//
// Run: node config/scripts/check-no-merge-base-revert.mjs [--base origin/main] [--head HEAD] [--json]
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const IGNORED_LINE = /^\s*(\/\/|\/\*|\*|#)?\s*$/

function git(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 1e9, encoding: 'utf8' })
}

function fileAt(root, ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: root,
      maxBuffer: 1e9,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

// A line "survives" if it appears anywhere in the head version. Position-independent on purpose:
// the point is whether the work is still present, not whether it moved.
export function findDroppedLines(baseText, targetText, headText) {
  if (baseText === null || targetText === null) {
    return []
  }
  const baseLines = new Set(baseText.split('\n').map((l) => l.trim()))
  const headLines = new Set((headText ?? '').split('\n').map((l) => l.trim()))
  const dropped = []
  for (const raw of targetText.split('\n')) {
    const line = raw.trim()
    if (IGNORED_LINE.test(line) || line.length < 8) {
      continue
    }
    // Only consider lines the base branch ADDED after the merge base.
    if (baseLines.has(line) || headLines.has(line)) {
      continue
    }
    dropped.push(line)
  }
  return dropped
}

export function analyze(root, baseRef, headRef) {
  const mergeBase = git(root, ['merge-base', baseRef, headRef]).trim()
  const changedByBase = new Set(
    git(root, ['diff', '--name-only', mergeBase, baseRef]).split('\n').filter(Boolean)
  )
  const changedByHead = new Set(
    git(root, ['diff', '--name-only', mergeBase, headRef]).split('\n').filter(Boolean)
  )
  const overlap = [...changedByBase].filter((f) => changedByHead.has(f)).sort()

  // Whole files the base branch ADDED that the topic branch lacks. Line-level comparison cannot see
  // these — the file simply is not there — yet dropping one silently removes a shipped feature.
  const missingFiles = []
  for (const file of git(root, ['diff', '--name-status', mergeBase, baseRef]).split('\n')) {
    const [status, ...rest] = file.split('\t')
    const target = rest.join('\t')
    if (status !== 'A' || !target) {
      continue
    }
    if (fileAt(root, headRef, target) === null) {
      missingFiles.push(target)
    }
  }

  const reverts = []
  for (const file of overlap) {
    const baseText = fileAt(root, mergeBase, file)
    const targetText = fileAt(root, baseRef, file)
    const headText = fileAt(root, headRef, file)
    if (targetText === null) {
      continue // deleted on the base branch; not a revert of added work
    }
    const dropped = findDroppedLines(baseText, targetText, headText)
    if (dropped.length > 0) {
      reverts.push({ file, droppedLines: dropped.length, sample: dropped.slice(0, 3) })
    }
  }
  reverts.sort((a, b) => b.droppedLines - a.droppedLines)
  return { mergeBase, overlapCount: overlap.length, reverts, missingFiles }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const root = path.resolve(import.meta.dirname, '../..')
  const argv = process.argv.slice(2)
  const readArg = (name, fallback) => {
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  const baseRef = readArg('--base', 'origin/main')
  const headRef = readArg('--head', 'HEAD')
  const asJson = argv.includes('--json')

  const { mergeBase, overlapCount, reverts, missingFiles } = analyze(root, baseRef, headRef)
  if (asJson) {
    console.log(JSON.stringify({ mergeBase, overlapCount, reverts, missingFiles }, null, 2))
  }
  if (missingFiles.length > 0) {
    console.error(
      `This branch is MISSING ${missingFiles.length} file(s) that ${baseRef} added since the merge base:\n`
    )
    for (const f of missingFiles.slice(0, 25)) {
      console.error(`  ${f}`)
    }
    if (missingFiles.length > 25) {
      console.error(`  ... and ${missingFiles.length - 25} more`)
    }
    console.error('')
  }
  if (reverts.length > 0 || missingFiles.length > 0) {
    if (reverts.length > 0) {
      console.error(
        `This branch drops work already present on ${baseRef} (merge base ${mergeBase.slice(0, 10)}).\n` +
          `${reverts.length} of ${overlapCount} overlapping files lose lines ${baseRef} added:\n`
      )
      for (const r of reverts.slice(0, 25)) {
        console.error(`  ${r.file}  (-${r.droppedLines} lines)`)
        for (const s of r.sample) {
          console.error(`      ${s.slice(0, 100)}`)
        }
      }
      if (reverts.length > 25) {
        console.error(`  ... and ${reverts.length - 25} more`)
      }
    }
    console.error(
      `\nRebuild by MERGING onto ${baseRef} rather than overwriting.` +
        `\nTypecheck and tests cannot catch this: a reverted feature still compiles and its old tests still pass.`
    )
    process.exit(1)
  }
  console.log(
    `no-merge-base-revert: clean (${overlapCount} overlapping files, 0 reverted, 0 missing)`
  )
}
