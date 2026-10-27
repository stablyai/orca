import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'

// Ratchet direct renderer workspace-record reads downward as sidebar records move to main’s feed (§2/§9); old-copy readers would silently go stale.
// Lower bound misses destructuring/computed access; compiler guards removed fields. Writers remain until their migration.

const BASELINE_PATH = 'config/workspace-record-read-baseline.txt'
const SCAN_ROOTS = ['src/renderer/src/']
// `x.worktreesByRepo`, `x?.folderWorkspaces`; not `...worktreesByRepo` or `window.api.folderWorkspaces`.
const RAW_READ =
  /(?<!\.\.)(?<!\bapi\??)\.(?:worktreesByRepo|folderWorkspaces|detectedWorktreesByRepo)\b/g

/** Files allowed to read the fields directly, with the reason. Keep each reason true. */
export const SELECTOR_FILES = new Map([
  [
    'src/renderer/src/store/workspace-record-selectors.ts',
    'the selector module is the one read path by definition'
  ]
])

export function isScannedFile(rel) {
  return (
    /\.tsx?$/.test(rel) &&
    !rel.endsWith('.d.ts') &&
    !/\.(?:test|spec)\.tsx?$|fixture|test-harness|test-support/.test(rel) &&
    !SELECTOR_FILES.has(rel)
  )
}

/** Drops comments and the contents of quoted strings, so prose and i18n keys never count. */
export function stripCommentsAndQuotedStrings(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === "'" || char === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== char && text[j] !== '\n') {
        j += text[j] === '\\' ? 2 : 1
      }
      out += `${char}${char}`
      i = j
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end - 1
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      out += ' '
    } else {
      out += char
    }
  }
  return out
}

export function countWorkspaceRecordReads(text) {
  return [...stripCommentsAndQuotedStrings(text).matchAll(RAW_READ)].length
}

export function collectWorkspaceRecordReads(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, text] of readTrackedSources(root, SCAN_ROOTS, isScannedFile)) {
    const count = countWorkspaceRecordReads(text)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'workspace-record-read',
      baselinePath: BASELINE_PATH,
      unit: 'direct workspace record field read(s)',
      header: [
        '# Renderer reads of `worktreesByRepo` / `folderWorkspaces` / `detectedWorktreesByRepo`',
        '# outside src/renderer/src/store/workspace-record-selectors.ts, as `<count> <file> # <why>`.',
        '# This is a RATCHET: counts may only go DOWN. Read through the selectors instead.',
        '# `P5b-2 must clear` rows read store state through a loosely typed or optional field: once the',
        '# fields leave the store they read undefined and silently fall back, so P5b-2 must move them.',
        '# Prune after a fix: pnpm check:workspace-record-read-ratchet --prune'
      ],
      collect: collectWorkspaceRecordReads,
      fix: [
        'Read workspace records through src/renderer/src/store/workspace-record-selectors.ts:',
        '  selectWorkspaceByHostTarget(state, target)  the owner of a HostWorktreeTarget',
        '  selectWorktreesByRepo / selectFolderWorkspaces / selectDetectedWorktreesByRepo',
        '                                              compatibility views of the old fields'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
