import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runEntryRatchet } from './ratchet-baseline.mjs'

// memo() blocks the parent re-render a language switch relies on, so a memoized component in a
// translating file must subscribe itself or its labels stay in the previous language.

const BASELINE_PATH = 'config/memo-translate-subscription-baseline.txt'
const SCAN_ROOT = 'src/renderer/src'
const HEADER = [
  '# Memoized components (<file>#<component>) in files that call translate() but that do not',
  '# subscribe to UI language changes. Each entry needs a note saying why it renders no',
  '# translated text. Prune after a fix: pnpm check:memo-translate-subscription-ratchet --prune'
]

const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm
const TRANSLATE_CALL = /\btranslate\(/
const SUBSCRIPTION_CALL = /\b(?:useUiLanguageRevision|useTranslation)\(/
const MEMO_CALL = /\b(?:React\.)?memo\(\s*(?:function\s+([\w$]+)|([\w$]+)\s*[,)])/g
const TOP_LEVEL_BOUNDARY = /^[^\s)}\]]/gm

function topLevelBlockFrom(sourceText, start, boundaries) {
  const end = boundaries.find((index) => index > start) ?? sourceText.length
  return sourceText.slice(start, end)
}

function declarationStart(sourceText, name) {
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:default\\s+)?(?:function\\s+${name}\\b|(?:const|let)\\s+${name}\\s*[:=])`,
    'm'
  )
  return declaration.exec(sourceText)?.index ?? null
}

export function isScannedPath(rel) {
  return rel.startsWith(`${SCAN_ROOT}/`) && rel.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(rel)
}

/** Memoized in-file components lacking a language subscription, when the file translates. */
export function findUnsubscribedMemoComponents(sourceText) {
  const code = sourceText.replace(COMMENT, ' ')
  if (!TRANSLATE_CALL.test(code)) {
    return []
  }
  const boundaries = [...code.matchAll(TOP_LEVEL_BOUNDARY)].map((match) => match.index)
  const unsubscribed = []
  for (const match of code.matchAll(MEMO_CALL)) {
    const inlineName = match[1]
    const name = inlineName ?? match[2]
    const start = inlineName ? match.index : declarationStart(code, name)
    // Memoized imports are checked in the file that declares them.
    if (start === null) {
      continue
    }
    const body = topLevelBlockFrom(code, start, boundaries)
    if (!SUBSCRIPTION_CALL.test(body)) {
      unsubscribed.push(name)
    }
  }
  return [...new Set(unsubscribed)]
}

export function collectUnsubscribedMemoComponents(root = process.cwd()) {
  const entries = []
  for (const [rel, source] of readTrackedSources(root, [SCAN_ROOT], isScannedPath)) {
    for (const name of findUnsubscribedMemoComponents(source)) {
      entries.push(`${rel}#${name}`)
    }
  }
  return entries.sort()
}

export function main(root = process.cwd(), arg = undefined) {
  return runEntryRatchet(
    {
      name: 'memo-translate-subscription',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectUnsubscribedMemoComponents,
      fix: [
        'Call useUiLanguageRevision() from @/i18n/use-ui-language-revision in the memoized',
        'component (and add its value to useMemo deps that build translated values).'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
