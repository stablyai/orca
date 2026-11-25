import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import {
  SCAN_ROOT,
  collectI18nCalls,
  isRenderPathCall,
  isScannedRendererPath,
  parseSource
} from '../../../localization/reactive-translate/render-path-translate.mjs'

// translate()/getIntlLocale() read the language from module state, so a memoized render keeps
// the old language; components and hooks read it from useTranslate()/useIntlLocale() instead.

const BASELINE_PATH = 'config/render-path-translate-baseline.txt'
const HEADER = [
  '# Render-path translate()/getIntlLocale() calls in components and hooks, per file.',
  '# This is a RATCHET: counts may only go DOWN. Use useTranslate()/useIntlLocale() from',
  '# @/i18n/use-translate. Prune after a fix: pnpm check:render-path-translate-ratchet --prune'
]
const I18N_CALL = /\b(?:translate|getIntlLocale)\b/

export function countRenderPathTranslateCalls(rel, sourceText) {
  if (!I18N_CALL.test(sourceText)) {
    return 0
  }
  return collectI18nCalls(parseSource(rel, sourceText)).calls.filter(isRenderPathCall).length
}

export function collectRenderPathTranslateCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, [SCAN_ROOT], isScannedRendererPath)) {
    const count = countRenderPathTranslateCalls(rel, source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'render-path-translate',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectRenderPathTranslateCounts,
      unit: 'render-path translate()/getIntlLocale() call(s)',
      fix: [
        'Call `const t = useTranslate()` (or `useIntlLocale()`) at the top of the component or',
        'hook and use it during render; React Compiler memoizes module translate() calls on',
        'their arguments only. Rewrite a file: pnpm i18n:reactive-translate <path>'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
