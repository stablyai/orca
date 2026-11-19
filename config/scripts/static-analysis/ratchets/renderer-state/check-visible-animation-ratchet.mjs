import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'

const SCAN_ROOT = 'src/renderer/src'
const BASELINE_PATH = 'config/visible-animation-baseline.txt'
const HEADER = [
  '# Raw spin/pulse class tokens in Electron renderer sources. Baseline: 0.',
  '# Web-only entry points and mobile-page.css do not run in Electron UI windows.'
]
const RAW_ANIMATION = /(?<![\w-])animate-(?:spin|pulse)(?![\w-])/g

export function isScannedPath(rel) {
  return (
    rel.startsWith(`${SCAN_ROOT}/`) &&
    /\.(?:[cm]?[jt]sx?|css|html)$/.test(rel) &&
    !rel.startsWith(`${SCAN_ROOT}/web/`) &&
    rel !== `${SCAN_ROOT}/assets/mobile-page.css`
  )
}

export function collectVisibleAnimationCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, [SCAN_ROOT], isScannedPath)) {
    const count = source.match(RAW_ANIMATION)?.length ?? 0
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'visible-animation',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectVisibleAnimationCounts,
      unit: 'raw spin/pulse class token(s)',
      fix: [
        'Use visible-animate-spin or visible-animate-pulse and attach observeVisibleAnimation',
        'to the same element. Preserve motion-safe and motion-reduce variants.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
