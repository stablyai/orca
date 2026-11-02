import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runEntryRatchet } from './ratchet-baseline.mjs'

// Ratchet on renderer files that import the deprecated runtime-owner resolvers. Both read a
// worktree that two hosts publish as "not a runtime", which callers then treat as local, so a stop,
// sleep or kill can land on the wrong machine. New code resolves the owner with its host and
// ambiguity kept; the importer list may only shrink.

const BASELINE_PATH = 'config/deprecated-runtime-owner-importers-baseline.txt'
const SCAN_ROOT = 'src/renderer/src'
const DEPRECATED_NAMES = ['getRuntimeEnvironmentIdForWorktree', 'resolveRuntimeOwnerForWorktree']
// The defining module and its own tests are not importers.
const DEFINING_FILE = 'src/renderer/src/lib/worktree-runtime-owner.ts'

// Any reference to a deprecated name in a file that loads the defining module, whatever the import
// form (named, aliased, namespace, dynamic, `.then` destructuring, re-export). Simpler than tracking
// bindings, and in production code a mention of these names is a use.
const DEPRECATED_NAME = new RegExp(`\\b(?:${DEPRECATED_NAMES.join('|')})\\b`)
const DEFINING_MODULE_SPECIFIER = /['"`][^'"`]*\/worktree-runtime-owner['"`]/
// Block and line comments; `://` inside a string (a URL) is not a line comment.
const COMMENT = /\/\*[\s\S]*?\*\/|(?<![:'"`\\])\/\/.*$/gm

export function isScannedPath(rel) {
  return (
    rel.startsWith(`${SCAN_ROOT}/`) &&
    /\.(ts|tsx)$/.test(rel) &&
    !/\.(test|spec)(?:-fixture|-support)?\.tsx?$/.test(rel) &&
    rel !== DEFINING_FILE
  )
}

/** True when uncommented code loads the defining module and names a deprecated resolver. */
export function importsDeprecatedRuntimeOwner(sourceText) {
  const code = sourceText.replace(COMMENT, ' ')
  return DEFINING_MODULE_SPECIFIER.test(code) && DEPRECATED_NAME.test(code)
}

export function collectDeprecatedRuntimeOwnerImporters(root = process.cwd()) {
  const sources = readTrackedSources(root, [SCAN_ROOT], isScannedPath)
  return [...sources]
    .filter(([, source]) => importsDeprecatedRuntimeOwner(source))
    .map(([rel]) => rel)
    .sort()
}

const RATCHET = {
  name: 'deprecated-runtime-owner',
  baselinePath: BASELINE_PATH,
  header: [
    '# Renderer files that import getRuntimeEnvironmentIdForWorktree / resolveRuntimeOwnerForWorktree.',
    '# This is a RATCHET: the list may only SHRINK. Both resolvers read an ambiguous (two-host)',
    '# worktree as "not a runtime", which callers treat as local.',
    '# Prune after migrating a file: pnpm check:deprecated-runtime-owner-ratchet --prune'
  ],
  collect: collectDeprecatedRuntimeOwnerImporters,
  fix: [
    'getRuntimeEnvironmentIdForWorktree / resolveRuntimeOwnerForWorktree collapse an owner that two',
    'hosts publish into "local". Resolve the owner with its host kept and refuse on ambiguity',
    'instead (see src/renderer/src/lib/resolve-owner.ts).'
  ]
}

export function main(root = process.cwd(), arg = undefined) {
  return runEntryRatchet(RATCHET, root, arg)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
