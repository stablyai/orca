import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'

// Why this gate exists: the `ref-oss` workflow reads a set of projects that is
// not itself public, and its findings describe that corpus — what it contains,
// what was surveyed, and what was NOT found in it. Those findings must never
// reach a shipped file. Nine pull request descriptions carried them before
// anyone looked, because no check reads prose.
//
// What is NOT policed, and must keep passing: naming a public project, linking
// its docs or spec, describing its observable behaviour, or saying where in it
// something was read. Orca integrates with several public projects and those
// statements are ordinary engineering documentation. Only claims about the
// unnamed corpus are rejected.

// Why assembled from fragments: this file is itself a changed file whenever the
// marker set is edited, so a spelled-out marker here would trip its own gate.
function phrase(...words) {
  return words.join(String.raw`\s+`)
}

// Citation reaching INTO the corpus: a preposition, then the corpus itself.
// Naming the corpus without citing it — as the skill's own description does —
// is not a finding about what it contains.
const CORPUS = phrase('reference', '(?:repos?|repositories|set|corpus)')
const INTO_CORPUS = String.raw`\b(?:in|from|across|against|per|within|throughout|among|amongst)\s+(?:the\s+|our\s+|these\s+|those\s+|all\s+|\d+\s+)?(?:local\s+)?(?:oss\s+)?`

export const PROVENANCE_MARKERS = [
  {
    id: 'reference-corpus-citation',
    hint: 'Citation into the reference corpus. Describe the named public project instead.',
    pattern: new RegExp(INTO_CORPUS + CORPUS + String.raw`\b`, 'i')
  },
  {
    id: 'reference-survey-framing',
    hint: 'Reference-survey framing. State the design conclusion on its own terms.',
    pattern: new RegExp(
      String.raw`\b` + phrase('reference', '(?:survey|sweep|audit)') + String.raw`\b`,
      'i'
    )
  },
  {
    id: 'precedent-framing',
    hint: 'Precedent-audit framing. Say what the design does and why.',
    pattern: /\bprecedent\s+(?:audit|check|survey|sweep|review)\b/i
  },
  {
    id: 'absence-claim',
    hint: 'Absence claim about the reference corpus. Drop it; it reports a search, not a fact.',
    pattern:
      /\b(?:no|zero)\s+(?:known\s+|directly\s+|closely\s+)?(?:precedent|prior art)\b|\bprior[- ]art\s+(?:survey|audit|check|sweep)\b|\bn(?:o|obody)\b.{0,60}?\b(?:directly\s+|closely\s+)?comparable\b.{0,120}?\bw(?:as|ere)\s+found\b/i
  },
  {
    id: 'sole-comparable-claim',
    hint: 'Claim about a single comparable case in an unnamed corpus. Name the project or drop it.',
    pattern: /\bthe\s+(?:one|only|single)\s+(?:directly\s+|closely\s+)?comparable\b/i
  },
  {
    id: 'repo-survey-claim',
    hint: 'Survey-of-repositories claim. Cite a named project or drop the count.',
    pattern:
      /\b(?:surveyed|audited|reviewed)\s+(?:all\s+|\d+\s+|the\s+)?(?:local\s+)?(?:oss|open[- ]source|reference)\s+(?:repos?|repositories|projects)\b|\b(?:none|neither)\s+of\s+the\s+(?:surveyed|reference|audited)\s+(?:repos?|repositories|projects)\b/i
  }
]

const SCANNABLE_FILE_PATTERN =
  /\.(?:[cm]?[jt]sx?|md|mdx|json|jsonc|ya?ml|txt|sh|zsh|bash|ps1|py|rs|go|css|html|toml)$/i
// Why a size cap rather than a name list: generated manifests and lockfiles are
// the only files this large, and a cap needs no maintenance as they are renamed.
const MAX_SCANNED_BYTES = 1024 * 1024

// Why the text is flattened first: these claims are prose, and prose wraps. The
// real #14661 bullet splits its "was found" clause across two lines behind a
// list indent, so a per-line scan would miss the very claim this gate exists to
// catch. Leading indent and a comment marker are dropped so a wrapped sentence
// reads as one.
function flattenForMatching(text) {
  const segments = []
  const lineStarts = []
  let cursor = 0
  for (const line of text.split(/\r?\n/)) {
    const segment = line.replace(/^\s*(?:\/\/+|\*+)?\s*/, '')
    lineStarts.push(cursor)
    segments.push(segment)
    cursor += segment.length + 1
  }
  return { flattened: segments.join(' '), lineStarts }
}

function lineForIndex(lineStarts, index) {
  let line = 1
  for (let candidate = 0; candidate < lineStarts.length; candidate += 1) {
    if (lineStarts[candidate] > index) {
      break
    }
    line = candidate + 1
  }
  return line
}

export function findProvenanceMarkers(text) {
  const findings = []
  const lines = text.split(/\r?\n/)
  const { flattened, lineStarts } = flattenForMatching(text)
  for (const marker of PROVENANCE_MARKERS) {
    const scanner = new RegExp(marker.pattern.source, `${marker.pattern.flags.replace('g', '')}g`)
    for (const match of flattened.matchAll(scanner)) {
      const line = lineForIndex(lineStarts, match.index)
      findings.push({ markerId: marker.id, hint: marker.hint, line, text: lines[line - 1].trim() })
    }
  }
  return findings.sort((a, b) => a.line - b.line)
}

function runGit(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function splitNullDelimited(output) {
  return output.split('\0').filter(Boolean)
}

function resolveBase(root, requestedBase) {
  for (const candidate of [
    requestedBase,
    process.env.ORCA_PROVENANCE_BASE,
    'origin/main',
    'main'
  ]) {
    if (!candidate) {
      continue
    }
    const result = spawnSync('git', ['rev-parse', '--verify', `${candidate}^{commit}`], {
      cwd: root,
      stdio: 'ignore'
    })
    if (result.status === 0) {
      return candidate
    }
  }
  throw new Error('Pass the pull request base SHA or make origin/main available locally.')
}

export function collectChangedFiles(root, requestedBase) {
  const base = resolveBase(root, requestedBase)
  const mergeBase = runGit(root, ['merge-base', base, 'HEAD']).trim()
  const comparisonBase = resolvePullRequestDiffBase(root, mergeBase)
  const changed = splitNullDelimited(
    runGit(root, ['diff', '--name-only', '-z', '--diff-filter=ACMRTUB', comparisonBase, '--'])
  )
  const untracked = splitNullDelimited(
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
  const files = [...new Set([...changed, ...untracked])].filter((file) => {
    if (!SCANNABLE_FILE_PATTERN.test(file)) {
      return false
    }
    const absolutePath = path.join(root, file)
    return existsSync(absolutePath) && statSync(absolutePath).size <= MAX_SCANNED_BYTES
  })
  return { base, comparisonBase, files }
}

function annotationValue(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

export function main(
  root = process.cwd(),
  requestedBase = process.argv.slice(2).find((argument) => argument !== '--')
) {
  const { base, comparisonBase, files } = collectChangedFiles(root, requestedBase)
  if (files.length === 0) {
    console.log(`Reference-provenance gate: no changed text files since ${base}.`)
    return 0
  }

  let failures = 0
  for (const file of files) {
    const findings = findProvenanceMarkers(readFileSync(path.join(root, file), 'utf8'))
    for (const finding of findings) {
      failures += 1
      const message = `${finding.hint} (${finding.markerId})`
      console.error(
        `::error file=${annotationValue(file)},line=${finding.line},title=${annotationValue('reference-corpus provenance')}::${annotationValue(message)}`
      )
      console.error(`${file}:${finding.line} ${finding.markerId}: ${finding.hint}`)
    }
  }

  if (failures > 0) {
    console.error(
      `Reference-provenance gate failed with ${failures} finding(s) across ${files.length} changed file(s). Drop the claim about the corpus; keep the engineering conclusion.`
    )
    return 1
  }
  console.log(
    `Reference-provenance gate passed across ${files.length} changed file(s) since ${comparisonBase.slice(0, 12)}.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
