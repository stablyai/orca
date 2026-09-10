/**
 * How an xterm patch is formatted, split and compared.
 *
 * Split out of regenerate-xterm-patches.mjs, which orchestrates the clone and the
 * builds. Everything here is pure text: it needs no upstream checkout, so the unit
 * tests exercise it with no network and no build.
 */

/**
 * Flags pnpm@12 passes to `git diff` in its own `diff_folders()`. A patch built
 * with anything else is a patch pnpm may re-diff differently on the next
 * `pnpm patch-commit`, so the byte-comparison gate would never settle.
 */
export const PNPM_DIFF_FLAGS = [
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.quotePath=false',
  'diff',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--ignore-cr-at-eol',
  '--irreversible-delete',
  '--full-index',
  '--no-index',
  '--text',
  '--no-ext-diff',
  '--no-color',
  '--'
]

/**
 * The same formatting as PNPM_DIFF_FLAGS minus `--no-index`, so a diff taken
 * inside the upstream checkout is byte-comparable with the emitted patch.
 * `--relative` scopes paths to the package directory, which is what the published
 * tarball is rooted at; it is a no-op for a package whose packageDir is the repo root.
 */
export const CHECKOUT_DIFF_FLAGS = PNPM_DIFF_FLAGS.filter((flag) => flag !== '--no-index').flatMap(
  // Ahead of the `--` separator, or git reads it as a pathspec and silently keeps
  // repo-root-relative paths.
  (flag) => (flag === '--' ? ['--relative', '--'] : [flag])
)

/** Applies pnpm's git config isolation so local machine settings cannot change the patch. */
export function pnpmDiffEnvironment(baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null'
  }
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trimSurroundingSlashes(value) {
  return value[0] === '/' || value.endsWith('/') ? value.replace(/^\/|\/$/g, '') : value
}

/**
 * Reproduces pnpm's post-processing of the raw `git diff` output: strip the two
 * scratch folder prefixes, drop a trailing no-newline marker, and remove
 * .DS_Store entries a macOS run would otherwise smuggle in.
 */
export function normalizePnpmDiff(stdout, folderA, folderB) {
  const a = folderA.replace(/\\/g, '/')
  const b = folderB.replace(/\\/g, '/')
  return stdout
    .replace(new RegExp(`(a|b)(${escapeRegExp(`/${trimSurroundingSlashes(a)}/`)})`, 'g'), '$1/')
    .replace(new RegExp(`(a|b)${escapeRegExp(`/${trimSurroundingSlashes(b)}/`)}`, 'g'), '$1/')
    .replace(new RegExp(escapeRegExp(`${a}/`), 'g'), '')
    .replace(new RegExp(escapeRegExp(`${b}/`), 'g'), '')
    .replace(/\n\\ No newline at end of file\n$/, '\n')
    .replace(/^diff --git a\/.*\.DS_Store b\/.*\.DS_Store[\s\S]+?(?=^diff --git)/gm, '')
    .replace(/^diff --git a\/.*\.DS_Store b\/.*\.DS_Store[\s\S]*$/gm, '')
}

/** Splits a patch into one entry per `diff --git` stanza, keeping the raw text. */
export function splitPatchEntries(patchText) {
  return patchText
    .split(/^(?=diff --git )/m)
    .filter((entry) => entry.startsWith('diff --git '))
    .map((text) => {
      const header = text.slice(0, text.indexOf('\n'))
      const match = /^diff --git a\/(.+) b\/\1$/.exec(header)
      if (!match) {
        throw new Error(`Unsupported diff header (renames are not supported): ${header}`)
      }
      return { path: match[1], text }
    })
}

export function selectPatchEntries(patchText, matches) {
  return splitPatchEntries(patchText)
    .filter((entry) => matches(entry.path))
    .map((entry) => entry.text)
    .join('')
}

/** The hand-editable half of a patch: everything under `src/`. */
export function sourceHunks(patchText) {
  return selectPatchEntries(patchText, (file) => file.startsWith('src/'))
}

/**
 * The source patch and the emitted patch are the same edits diffed two ways, so
 * they must produce the same bytes. A source hunk the emitted patch cannot carry
 * would be deleted by the next `--write`, so this fails instead of shipping one.
 */
export function assertSourceDerivationsAgree(checkoutSource, patchText) {
  const checkout = sourceHunks(checkoutSource)
  const emitted = sourceHunks(patchText)
  if (checkout === emitted) {
    return
  }
  throw new Error(
    [
      'The checkout diff and the emitted patch disagree on a source file.',
      `  from checkout: [${splitPatchEntries(checkout)
        .map((e) => e.path)
        .join(', ')}]`,
      `  from patch:    [${splitPatchEntries(emitted)
        .map((e) => e.path)
        .join(', ')}]`,
      `  first difference at character ${firstDifferenceIndex(checkout, emitted)}`,
      '',
      'A hunk the emitted patch cannot name is never installed, so it cannot ship',
      'here; upstream .npmignore strips `src/**/*.test.ts`.'
    ].join('\n')
  )
}

export function firstDifferenceIndex(left, right) {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) {
      return index
    }
  }
  return left.length === right.length ? -1 : limit
}

export function formatCheckFailure({ name, patchPath, committed, regenerated }) {
  const index = firstDifferenceIndex(committed, regenerated)
  const committedFiles = splitPatchEntries(committed).map((entry) => entry.path)
  const regeneratedFiles = splitPatchEntries(regenerated).map((entry) => entry.path)
  return [
    `${name}: ${patchPath} is not what the pinned upstream build produces.`,
    `  committed:   ${Buffer.byteLength(committed)} bytes, files [${committedFiles.join(', ')}]`,
    `  regenerated: ${Buffer.byteLength(regenerated)} bytes, files [${regeneratedFiles.join(', ')}]`,
    `  first difference at character ${index}`,
    '',
    'The bundle hunks are generated. Do not edit them. Change the source patch',
    'instead and regenerate both files:',
    '',
    '  node config/scripts/regenerate-xterm-patches.mjs --write',
    '',
    'See docs/reference/xterm-patch-regeneration.md.'
  ].join('\n')
}
