import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runEntryRatchet } from './ratchet-baseline.mjs'
import { collectModuleSpecifiers } from './static-module-specifiers.mjs'

// COMPAT(legacy-relay-bridge): fences what the 2027-01-15 relay retirement deletes. Everything
// that exists only for released relay hosts lives in LEGACY_FOLDER; files outside it that import
// it, or carry the COMPAT tag, are the seams that retirement edits. Both lists may only shrink.

const LEGACY_FOLDER = 'src/main/ssh/legacy-relay'
const SCAN_ROOTS = ['src', 'tests', 'config', 'mobile/src']
const COMPAT_TAG = 'COMPAT(legacy-relay-bridge)'
// The gate names the tag it counts; it is not a seam.
const SELF = 'config/scripts/check-legacy-relay-fence-ratchet.'
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/

function isOutsideFolder(rel) {
  return !rel.startsWith(`${LEGACY_FOLDER}/`)
}

/** True when a relative specifier from `file` lands inside the legacy folder. */
export function importsLegacyFolder(file, specifier) {
  const normalized = specifier.replaceAll('\\', '/')
  if (!normalized.startsWith('.')) {
    return false
  }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), normalized))
  return target === LEGACY_FOLDER || target.startsWith(`${LEGACY_FOLDER}/`)
}

export function collectLegacyRelayImporters(
  root = process.cwd(),
  specifiersFor = collectModuleSpecifiers
) {
  const sources = readTrackedSources(
    root,
    SCAN_ROOTS,
    (rel) => CODE.test(rel) && isOutsideFolder(rel)
  )
  return [...sources]
    .filter(
      ([rel, text]) =>
        text.includes('legacy-relay') &&
        specifiersFor(rel, text).some((s) => importsLegacyFolder(rel, s))
    )
    .map(([rel]) => rel)
    .sort()
}

export function collectLegacyRelayCompatTags(root = process.cwd()) {
  const sources = readTrackedSources(
    root,
    SCAN_ROOTS,
    (rel) => isOutsideFolder(rel) && !rel.endsWith('-baseline.txt') && !rel.startsWith(SELF)
  )
  return [...sources]
    .filter(([, text]) => text.includes(COMPAT_TAG))
    .map(([rel]) => rel)
    .sort()
}

const IMPORTERS = {
  name: 'legacy-relay-fence',
  baselinePath: 'config/legacy-relay-importers-baseline.txt',
  header: [
    `# Files outside ${LEGACY_FOLDER}/ that import it. RATCHET: may only SHRINK.`,
    '# The relay retirement (2027-01-15) deletes the folder and edits exactly these files.',
    '# Prune: pnpm check:legacy-relay-fence-ratchet --prune'
  ],
  collect: (root) => collectLegacyRelayImporters(root),
  fix: [
    `New code must not reach into ${LEGACY_FOLDER}/. Released relay hosts are served only by the`,
    'existing seams; put relay-only code inside the folder and reach it from an existing importer.'
  ]
}

const TAGS = {
  name: 'legacy-relay-fence',
  baselinePath: 'config/legacy-relay-compat-tags-baseline.txt',
  header: [
    `# Files outside ${LEGACY_FOLDER}/ tagged ${COMPAT_TAG}. RATCHET: may only SHRINK.`,
    '# Each tag marks code the relay retirement (2027-01-15) deletes or edits.',
    '# Prune: pnpm check:legacy-relay-fence-ratchet --prune'
  ],
  collect: (root) => collectLegacyRelayCompatTags(root),
  fix: [
    `A new ${COMPAT_TAG} seam outside ${LEGACY_FOLDER}/ grows what retirement must edit.`,
    'Keep relay-only behaviour inside the folder instead.'
  ]
}

export function main(root = process.cwd(), arg = undefined) {
  const importers = runEntryRatchet(IMPORTERS, root, arg)
  const tags = runEntryRatchet(TAGS, root, arg)
  return importers || tags
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
