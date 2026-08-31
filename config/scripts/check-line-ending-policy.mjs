#!/usr/bin/env node
/**
 * Gate: no executable artifact in this repo may carry — or acquire — CRLF.
 *
 * Orca ships shell scripts straight out of the tree (`resources/linux/bin/orca-ide`,
 * `resources/darwin/bin/orca`, the deb/rpm maintainer scripts). A `\r` on the shebang
 * line does not degrade them, it stops them executing: the loader looks for an
 * interpreter literally named `bash\r`. `.gitattributes` pins the whole tree to LF,
 * and this gate is what keeps that pin honest.
 *
 * Two independent failure modes, so two independent assertions per file:
 *   1. the committed blob must not contain CRLF   — what every user gets, all platforms
 *   2. `git check-attr eol` must resolve to `lf`  — what a Windows contributor checks out
 * (1) alone passes while a stray `eol=crlf` still breaks the Windows working tree, and
 * (2) alone passes while a `-text` blob ships CRLF to everyone. Neither implies the other.
 *
 * Shape — why this is not a curated file list and not a repo-wide "no CRLF" rule:
 *   - A curated list would have to name 122 files today, and would silently miss the
 *     123rd. Not enumerating them is exactly how this bug shipped, so the population is
 *     DERIVED from content (leading `#!`) and mode (the executable bit). New scripts are
 *     covered the moment they land, with nothing to remember.
 *   - A repo-wide rule over-fires: `config/patches/*.patch` are deliberately `-text`
 *     because pnpm hashes them byte-for-byte, and whether the Windows CLI shim should
 *     ship CRLF is an open product decision this gate must not pre-empt.
 * There is deliberately no exemption list: CRLF is never correct for a file the OS has
 * to exec, so the threshold is zero rather than a ratchet that can drift upward.
 *
 * Usage: node config/scripts/check-line-ending-policy.mjs
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const EXECUTABLE_MODE = '100755'

/** A blob is an executable artifact if the OS will exec it: shebang, or the mode bit. */
export function hasShebang(blob) {
  return blob.length >= 2 && blob[0] === 0x23 && blob[1] === 0x21
}

export function containsCrlf(blob) {
  return blob.includes('\r\n')
}

/** `git check-attr -z --stdin` emits NUL-separated <path> <attr> <value> triples. */
export function parseCheckAttr(stdout) {
  const tokens = stdout.split('\0')
  const byPath = new Map()
  // Every record is NUL-TERMINATED, so a well-formed stream splits into 3n+1 tokens with
  // an empty tail. Requiring that terminator stops a truncated read inventing a record.
  for (let i = 0; i + 3 <= tokens.length - 1; i += 3) {
    const [file, attr, value] = [tokens[i], tokens[i + 1], tokens[i + 2]]
    if (!byPath.has(file)) {
      byPath.set(file, {})
    }
    byPath.get(file)[attr] = value
  }
  return byPath
}

/**
 * @param entries {{ path: string, reason: string, crlf: boolean }[]}
 * @param attrs Map<string, { eol?: string }>
 */
export function findViolations(entries, attrs) {
  const violations = []
  for (const entry of entries) {
    if (entry.crlf) {
      violations.push({
        path: entry.path,
        rule: 'committed blob contains CRLF',
        detail: `${entry.reason}; the shipped bytes are broken on every platform, not just Windows`
      })
    }
    const eol = attrs.get(entry.path)?.eol
    if (eol !== 'lf') {
      violations.push({
        path: entry.path,
        rule: `checked out with eol=${eol ?? 'unspecified'}, not lf`,
        detail: `${entry.reason}; a core.autocrlf=true clone would write CRLF into it`
      })
    }
  }
  return violations
}

/**
 * Why the explicit status check: `git grep` exits 1 on "no matches", which is
 * indistinguishable from a failure unless we look. A silently empty result here would
 * drop 100+ files from the population and still report a clean repo.
 */
function git(root, args, input, okStatuses = [0]) {
  // No `encoding`: stdout must stay a Buffer so blob bytes survive intact.
  const result = spawnSync('git', args, {
    cwd: root,
    input: input === undefined ? undefined : Buffer.from(input, 'utf8'),
    maxBuffer: 512 * 1024 * 1024
  })
  if (result.error) {
    throw result.error
  }
  if (!okStatuses.includes(result.status)) {
    throw new Error(
      `git ${args[0]} exited ${result.status}: ${result.stderr.toString('utf8').trim()}`
    )
  }
  return result
}

function gitText(root, args, input, okStatuses) {
  return git(root, args, input, okStatuses).stdout.toString('utf8')
}

/**
 * Reads several blobs in one `cat-file --batch` pass, keyed by path.
 *
 * Requests are by object id, not by `:path`: a path containing a newline or a quoted
 * character would otherwise corrupt the request stream.
 */
function readIndexBlobs(root, files) {
  if (files.length === 0) {
    return new Map()
  }
  const request = `${files.map(({ sha }) => sha).join('\n')}\n`
  const stdout = git(root, ['cat-file', '--batch'], request).stdout
  const blobs = new Map()
  let cursor = 0
  for (const { path: file } of files) {
    const headerEnd = stdout.indexOf('\n', cursor)
    if (headerEnd === -1) {
      break
    }
    const header = stdout.subarray(cursor, headerEnd).toString('utf8').split(' ')
    // `<sha> missing` has no size field; a path we just listed should never hit this.
    if (header.length < 3) {
      throw new Error(`git cat-file could not read :${file}`)
    }
    const size = Number(header[2])
    blobs.set(file, stdout.subarray(headerEnd + 1, headerEnd + 1 + size))
    cursor = headerEnd + 1 + size + 1
  }
  return blobs
}

/**
 * Why the index and not the working tree: on a CRLF clone every file "has" CRLF, so a
 * working-tree scan would fail for everyone on Windows and prove nothing. The committed
 * blob is the thing that actually ships.
 */
export function collectExecutableArtifacts(root) {
  const index = new Map()
  const executableBit = new Set()
  for (const entry of gitText(root, ['ls-files', '-s', '-z']).split('\0')) {
    if (!entry) {
      continue
    }
    const tab = entry.indexOf('\t')
    if (tab === -1) {
      continue
    }
    const [mode, sha] = entry.slice(0, tab).split(' ')
    const file = entry.slice(tab + 1)
    index.set(file, sha)
    if (mode === EXECUTABLE_MODE) {
      executableBit.add(file)
    }
  }
  // `git grep` narrows 20k tracked files to ~130 candidates in one C-side pass; the
  // anchor is per-line, so this is a superset that the blob read below trims exactly.
  // `-z` because plain `-l` quotes any path git considers unusual.
  const shebangCandidates = gitText(
    root,
    ['grep', '--cached', '-l', '-z', '-E', '^#!', '--', '.'],
    undefined,
    [0, 1]
  )
    .split('\0')
    .filter(Boolean)

  const paths = [...new Set([...executableBit, ...shebangCandidates])].sort()
  const files = paths
    .filter((file) => index.has(file))
    .map((file) => ({
      path: file,
      sha: index.get(file)
    }))
  const blobs = readIndexBlobs(root, files)
  const entries = []
  for (const file of paths) {
    const blob = blobs.get(file)
    if (!blob) {
      continue
    }
    const shebang = hasShebang(blob)
    const executable = executableBit.has(file)
    if (!shebang && !executable) {
      continue
    }
    entries.push({
      path: file,
      reason: shebang ? 'starts with a shebang' : 'tracked with the executable bit',
      crlf: containsCrlf(blob)
    })
  }
  return entries
}

export function checkLineEndingPolicy(root) {
  const entries = collectExecutableArtifacts(root)
  const attrs = parseCheckAttr(
    gitText(
      root,
      ['check-attr', '-z', '--stdin', 'eol'],
      `${entries.map((e) => e.path).join('\0')}\0`
    )
  )
  return { entries, violations: findViolations(entries, attrs) }
}

function main(root) {
  const { entries, violations } = checkLineEndingPolicy(root)
  if (entries.length === 0) {
    // A population of zero means the discovery broke, not that the repo got clean.
    console.error('::error::line-ending policy: found no executable artifacts to check.')
    return 1
  }
  if (violations.length > 0) {
    console.error(`\nLine-ending policy violations (${violations.length}):\n`)
    for (const v of violations) {
      console.error(`  ${v.path}\n    ${v.rule} — ${v.detail}`)
    }
    console.error(
      '\nExecutable artifacts must be LF everywhere. Fix .gitattributes rather than the file,' +
        '\nthen re-stage with `git add --renormalize <path>`. Do not add a suppression.\n'
    )
    return 1
  }
  console.log(`line-ending policy OK — ${entries.length} executable artifact(s), all LF.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(path.join(import.meta.dirname, '..', '..')))
}
