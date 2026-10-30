import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'

// Web links from Orca's UI go through openAppHttpLink so they honour the link setting (#28692).

const BASELINE_PATH = 'config/direct-link-open-baseline.txt'
const SCAN_ROOTS = ['src/renderer/src']
const HEADER = [
  '# Direct system-browser opens (shell.openUrl / window.open) per renderer file.',
  '# This is a RATCHET: counts may only go DOWN. Open web links with openAppHttpLink',
  '# (src/renderer/src/lib/app-http-link-open.ts). Only sign-in, API-token and star-Orca',
  '# pages, explicit "open in default browser" actions, Orca installer recovery, port',
  '# opens that route themselves, chat links whose owner is unresolved and windows',
  '# without a workspace browser stay here.',
  '# Prune after a fix: pnpm check:direct-link-open-ratchet --prune'
]

const DIRECT_OPEN = /\bshell\.openUrl\(|\bwindow\.open\(/g
// Block and line comments; `://` inside a string (a URL) is not a line comment.
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm

function isScannedPath(rel) {
  return (
    SCAN_ROOTS.some((root) => rel.startsWith(`${root}/`)) &&
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)\.tsx?$/.test(rel) &&
    !/(?:^|[/.-])(?:test-fixture|test-support|test-harness|fixtures?)(?:[/.-]|$)|__fixtures__/.test(
      rel
    )
  )
}

function collectDirectLinkOpenCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = source.replace(COMMENT, ' ').match(DIRECT_OPEN)?.length ?? 0
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'direct-link-open',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectDirectLinkOpenCounts,
      unit: 'direct system-browser open(s)',
      fix: ['Open web links with openAppHttpLink (src/renderer/src/lib/app-http-link-open.ts).']
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
