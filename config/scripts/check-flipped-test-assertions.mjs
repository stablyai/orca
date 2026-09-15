import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  resolveExistingDiffBase,
  resolvePullRequestDiffBase
} from './git-pull-request-diff-base.mjs'
import {
  collectFindings,
  formatFinding,
  SCOPED_DIRECTORIES
} from './test-expectation-flip-heuristics.mjs'

// PR gate: a diff that stops an existing test asserting what it used to (see
// test-expectation-flip-heuristics.mjs for the four shapes) must say what a user sees.
// The only way out is a `## User-visible change` section in the PR body, which is one
// paragraph, and which nobody wrote for #19684.

const SECTION_HEADING = /^#{2,6}\s+User-visible change$/
const ANY_HEADING = /^#{1,6}\s+\S/

const INSTRUCTIONS = [
  'This change rewrites or disables what an existing test expects. If that is intentional,',
  'the product behaviour it pins changed too, so say what a user sees. Add this to the PR body:',
  '',
  '  ## User-visible change',
  '  Before: <what the user got with the old expectation>',
  '  After: <what the user gets now>',
  '',
  'If nothing user-visible changed, the test is asserting something the product still does',
  'not do — restore the old expectation instead of the section.'
].join('\n')

// Exact by design: `## User-visible changes` (plural) is not this section, and a
// pointer to it from some other heading is not the section either.
export function hasUserVisibleChangeSection(body) {
  const lines = (body ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => SECTION_HEADING.test(line.trim()))
  if (start === -1) {
    return false
  }
  let before = false
  let after = false
  for (const line of lines.slice(start + 1)) {
    if (ANY_HEADING.test(line.trim())) {
      break
    }
    const text = line.replace(/^[\s>]*(?:[-*+]\s+)?(?:\*\*|__|\*|_)?/, '')
    before ||= text.startsWith('Before:')
    after ||= text.startsWith('After:')
  }
  return before && after
}

function annotationValue(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

function collectScopedDiff(root, requestedBase) {
  const base = resolveExistingDiffBase(root, requestedBase)
  const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  return execFileSync(
    'git',
    [
      'diff',
      '--unified=0',
      '--no-color',
      resolvePullRequestDiffBase(root, mergeBase),
      '--',
      ...SCOPED_DIRECTORIES
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
}

function parseArguments(argv) {
  const options = { diffFile: null, requireBody: false, requestedBase: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--require-body') {
      options.requireBody = true
    } else if (argument.startsWith('--diff-file=')) {
      options.diffFile = argument.slice('--diff-file='.length)
    } else if (argument === '--diff-file') {
      index += 1
      options.diffFile = argv[index]
    } else if (argument !== '--' && !argument.startsWith('--') && !options.requestedBase) {
      options.requestedBase = argument
    }
  }
  return options
}

export function main(argv = process.argv.slice(2), root = process.cwd(), env = process.env) {
  const { diffFile, requireBody, requestedBase } = parseArguments(argv)
  const diff =
    diffFile === null
      ? collectScopedDiff(root, requestedBase)
      : readFileSync(diffFile === '-' ? 0 : diffFile, 'utf8')
  const findings = collectFindings(diff)
  if (findings.length === 0) {
    console.log('Flipped-assertion gate: no rewritten test expectations in the gated paths.')
    return 0
  }
  for (const finding of findings) {
    console.error(
      `::error file=${annotationValue(finding.file)},line=${finding.line},title=${annotationValue(finding.kind)}::${annotationValue(INSTRUCTIONS.split('\n')[0])}`
    )
    console.error(formatFinding(finding))
  }
  if (hasUserVisibleChangeSection(env.PR_BODY)) {
    console.log(
      `Flipped-assertion gate: ${findings.length} rewritten expectation(s), explained by the PR body's "## User-visible change" section.`
    )
    return 0
  }
  console.error('')
  console.error(INSTRUCTIONS)
  if (requireBody) {
    return 1
  }
  console.log(
    'Reporting only: CI passes --require-body, which turns the findings above into a failure.'
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
