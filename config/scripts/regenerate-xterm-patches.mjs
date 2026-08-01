#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const MANIFEST_RELATIVE_PATH = path.join('config', 'patches', 'xterm-upstream.json')

/**
 * Flags pnpm@10 passes to `git diff` in its own `diffFolders()`. A patch built
 * with anything else is a patch pnpm may re-diff differently on the next
 * `pnpm patch-commit`, so the byte-comparison gate would never settle.
 */
export const PNPM_DIFF_FLAGS = [
  '-c',
  'core.safecrlf=false',
  'diff',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--ignore-cr-at-eol',
  '--irreversible-delete',
  '--full-index',
  '--no-index',
  '--text',
  '--no-ext-diff',
  '--no-color'
]

/** Blanks the vars pnpm blanks so user and system git config cannot reach the diff. */
export function pnpmDiffEnvironment(baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: '',
    XDG_CONFIG_HOME: '',
    USERPROFILE: ''
  }
}

function escapeRegExp(value) {
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

/** The derived half of a patch: build output, never edited by hand. */
export function generatedHunks(patchText, generatedPaths) {
  return selectPatchEntries(patchText, (file) =>
    generatedPaths.some((prefix) => file.startsWith(prefix))
  )
}

export function stampVersionSource(source, version) {
  const stamped = source.replace(
    /export const XTERM_VERSION = '[^']+';/,
    `export const XTERM_VERSION = '${version}';`
  )
  if (stamped === source && !source.includes(`'${version}'`)) {
    throw new Error('Version stamp file does not declare XTERM_VERSION')
  }
  return stamped
}

/**
 * The published tarball names the commit it was built from, so a version bump
 * that forgets the manifest fails here instead of producing a patch against the
 * wrong tree.
 */
export function assertPublishedCommit(publishedPackageJson, packageEntry, upstreamCommit) {
  if (publishedPackageJson.version !== packageEntry.version) {
    throw new Error(
      `${packageEntry.name}: registry served ${publishedPackageJson.version}, manifest pins ${packageEntry.version}`
    )
  }
  if (publishedPackageJson.commit !== upstreamCommit) {
    throw new Error(
      [
        `${packageEntry.name}@${packageEntry.version} was published from commit`,
        `  ${publishedPackageJson.commit ?? '(absent)'}`,
        `but ${MANIFEST_RELATIVE_PATH} pins`,
        `  ${upstreamCommit}`,
        'Update upstream.commit in the manifest to the published commit, then rerun with --write.'
      ].join('\n')
    )
  }
}

/** Guards the publish-order trap: a dev esbuild pass would silently de-minify lib/*.mjs. */
export function assertBuildStepsAllowed(manifest) {
  const forbidden = new Set(manifest.forbiddenBuildScripts?.scripts ?? [])
  for (const packageEntry of manifest.packages) {
    for (const step of packageEntry.build) {
      const script = step.command === 'npm' && step.args[0] === 'run' ? step.args[1] : undefined
      if (script !== undefined && forbidden.has(script)) {
        throw new Error(
          `${packageEntry.name}: build step \`npm run ${script}\` is forbidden. ${manifest.forbiddenBuildScripts.why}`
        )
      }
    }
  }
}

/**
 * pnpm keys the patched package directory and the lockfile entry by the
 * sha256 of the patch file itself, so a regenerated patch that leaves
 * pnpm-lock.yaml alone fails `--frozen-lockfile` on every machine but the
 * author's.
 */
export function patchHash(patchText) {
  return createHash('sha256').update(patchText, 'utf8').digest('hex')
}

function lockfilePatchHashPattern(packageKey) {
  // Unscoped keys such as `node-pty@1.1.0` are emitted unquoted.
  return new RegExp(`(^  '?${escapeRegExp(packageKey)}'?:\\n    hash: )([0-9a-f]{64})$`, 'm')
}

export function readLockfilePatchHash(lockfileText, packageKey) {
  const match = lockfilePatchHashPattern(packageKey).exec(lockfileText)
  if (!match) {
    throw new Error(`pnpm-lock.yaml has no patchedDependencies entry for '${packageKey}'`)
  }
  return match[2]
}

export function updateLockfilePatchHash(lockfileText, packageKey, hash) {
  readLockfilePatchHash(lockfileText, packageKey)
  return lockfileText.replace(lockfilePatchHashPattern(packageKey), `$1${hash}`)
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

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    ...options
  })
}

function listFilesRelative(root, base = root) {
  const files = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const absolute = path.join(base, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFilesRelative(root, absolute))
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute))
    }
  }
  return files.sort()
}

function sameBytes(left, right) {
  return (
    statSync(left).size === statSync(right).size && readFileSync(left).equals(readFileSync(right))
  )
}

function fetchPristinePackage(packageEntry, workDir) {
  const target = path.join(workDir, 'pristine', packageEntry.name.replace(/[@/]/g, '_'))
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  const spec = `${packageEntry.name}@${packageEntry.version}`
  const output = run('npm', ['pack', spec, '--pack-destination', target, '--silent'], {
    cwd: workDir
  })
  const tarball = path.join(target, output.trim().split('\n').at(-1).trim())
  run('tar', ['xzf', tarball, '-C', target])
  return path.join(target, 'package')
}

function hasCommit(root, commit) {
  try {
    return run('git', ['cat-file', '-t', commit], { cwd: root, stdio: 'pipe' }).trim() === 'commit'
  } catch {
    return false
  }
}

function ensureUpstreamCheckout(manifest, workDir) {
  const root = path.join(workDir, 'upstream')
  const { repository, commit } = manifest.upstream
  if (!existsSync(path.join(root, '.git'))) {
    mkdirSync(root, { recursive: true })
    run('git', ['init', '--quiet'], { cwd: root })
    run('git', ['remote', 'add', 'origin', repository], { cwd: root })
  }
  if (!hasCommit(root, commit)) {
    run('git', ['fetch', '--depth=1', 'origin', commit], { cwd: root, stdio: 'inherit' })
  }
  run('git', ['checkout', '--quiet', '--detach', commit], { cwd: root })
  run('git', ['reset', '--quiet', '--hard', commit], { cwd: root })
  return root
}

function ensureDependencies(upstreamRoot, manifest) {
  const lockfile = path.join(upstreamRoot, 'package-lock.json')
  const stamp = path.join(upstreamRoot, 'node_modules', '.orca-xterm-install-stamp')
  const want = `${manifest.upstream.commit}\n${statSync(lockfile).size}\n`
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === want) {
    return
  }
  run('npm', ['ci'], {
    cwd: upstreamRoot,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', PUPPETEER_SKIP_DOWNLOAD: '1' }
  })
  assertToolchain(upstreamRoot, manifest)
  writeFileSync(stamp, want)
}

function assertToolchain(upstreamRoot, manifest) {
  const expected = manifest.toolchain
  for (const [name, version] of Object.entries(expected)) {
    if (name === 'why') {
      continue
    }
    const installed = path.join(upstreamRoot, 'node_modules', name, 'package.json')
    if (!existsSync(installed)) {
      throw new Error(
        `Upstream install is missing ${name}. The pinned toolchain is no longer resolvable; see the tsgo note in docs/reference/xterm-patch-regeneration.md.`
      )
    }
    const actual = JSON.parse(readFileSync(installed, 'utf8')).version
    if (actual !== version) {
      throw new Error(
        `Upstream ${name} resolved to ${actual}, manifest expects ${version}. Update the toolchain block only together with a verified rebuild.`
      )
    }
  }
}

/**
 * The published src/ must equal the pinned commit's src/ apart from the version
 * stamp publish.js rewrites. If it does not, the manifest points at the wrong
 * commit and every hunk below would be nonsense.
 */
function assertPristineSourceMatches(pristineDir, upstreamRoot, packageEntry) {
  const stampFile = packageEntry.versionStampFile
  const sourceRoot = path.join(pristineDir, 'src')
  const drifted = listFilesRelative(sourceRoot)
    .map((relative) => path.join('src', relative))
    .filter((relative) => relative !== stampFile)
    .filter(
      (relative) =>
        !sameBytes(
          path.join(pristineDir, relative),
          path.join(upstreamRoot, packageEntry.packageDir, relative)
        )
    )
  if (drifted.length > 0) {
    throw new Error(
      `Published src/ does not match ${packageEntry.packageDir} at the pinned commit: ${drifted.join(', ')}`
    )
  }
}

function buildPackage(upstreamRoot, packageEntry, manifest) {
  const packageRoot = path.join(upstreamRoot, packageEntry.packageDir)
  for (const directory of ['lib', 'out', 'out-esbuild']) {
    rmSync(path.join(packageRoot, directory), { recursive: true, force: true })
  }
  const stampPath = path.join(packageRoot, packageEntry.versionStampFile)
  writeFileSync(
    stampPath,
    stampVersionSource(readFileSync(stampPath, 'utf8'), packageEntry.version)
  )
  assertBuildStepsAllowed(manifest)
  for (const step of packageEntry.build) {
    run(step.command, step.args, { cwd: path.join(packageRoot, step.cwd), stdio: 'inherit' })
  }
}

/** Proves the pinned toolchain still reproduces the untouched published bundles. */
function assertReproducesPristineBundles(pristineDir, upstreamRoot, packageEntry) {
  const packageRoot = path.join(upstreamRoot, packageEntry.packageDir)
  const drifted = listFilesRelative(pristineDir)
    .filter((relative) =>
      packageEntry.generatedPaths.some((prefix) => toPosix(relative).startsWith(prefix))
    )
    .filter(
      (relative) => !sameBytes(path.join(pristineDir, relative), path.join(packageRoot, relative))
    )
  if (drifted.length > 0) {
    throw new Error(
      [
        `Rebuilding ${packageEntry.name}@${packageEntry.version} from the pinned commit did not reproduce the published bundles:`,
        ...drifted.map((relative) => `  ${relative}`),
        '',
        'Refusing to emit a patch. Either the toolchain drifted or the build ran in the',
        'wrong order (a dev `npm run setup` pass de-minifies lib/*.mjs).'
      ].join('\n')
    )
  }
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function overlayBuildOutput(pristineDir, upstreamRoot, packageEntry, destination) {
  rmSync(destination, { recursive: true, force: true })
  cpSync(pristineDir, destination, { recursive: true })
  const packageRoot = path.join(upstreamRoot, packageEntry.packageDir)
  for (const relative of listFilesRelative(pristineDir)) {
    // package.json carries the registry's version/commit stamp, which the build
    // tree has no way to reproduce and which we never want to patch.
    if (relative === 'package.json') {
      continue
    }
    const built = path.join(packageRoot, relative)
    if (!existsSync(built)) {
      throw new Error(`Published file has no build-tree counterpart: ${relative}`)
    }
    copyFileSync(built, path.join(destination, relative))
  }
}

function diffFolders(folderA, folderB) {
  let stdout
  try {
    stdout = execFileSync('git', [...PNPM_DIFF_FLAGS, folderA, folderB], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      env: pnpmDiffEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    // `git diff --no-index` exits 1 whenever it finds differences.
    if (error.status !== 1 || error.stderr?.length > 0) {
      throw error
    }
    stdout = error.stdout
  }
  return normalizePnpmDiff(stdout, folderA, folderB)
}

function regeneratePackage(packageEntry, manifest, context) {
  const { workDir, repoRoot } = context
  const pristineDir = fetchPristinePackage(packageEntry, workDir)
  const published = JSON.parse(readFileSync(path.join(pristineDir, 'package.json'), 'utf8'))
  assertPublishedCommit(published, packageEntry, manifest.upstream.commit)

  const upstreamRoot = ensureUpstreamCheckout(manifest, workDir)
  ensureDependencies(upstreamRoot, manifest)
  assertPristineSourceMatches(pristineDir, upstreamRoot, packageEntry)

  buildPackage(upstreamRoot, packageEntry, manifest)
  assertReproducesPristineBundles(pristineDir, upstreamRoot, packageEntry)

  run('git', ['reset', '--quiet', '--hard', manifest.upstream.commit], { cwd: upstreamRoot })
  run('git', ['apply', '--whitespace=nowarn', path.join(repoRoot, packageEntry.sourcePatch)], {
    cwd: path.join(upstreamRoot, packageEntry.packageDir)
  })
  buildPackage(upstreamRoot, packageEntry, manifest)

  const patchedDir = path.join(workDir, 'patched', packageEntry.name.replace(/[@/]/g, '_'))
  overlayBuildOutput(pristineDir, upstreamRoot, packageEntry, patchedDir)

  // Leave the checkout diffable: the pinned commit plus the source patch, with
  // no publish-time version stamp mixed in, so `git diff` there is the source
  // patch and nothing else.
  run('git', ['checkout', '--', packageEntry.versionStampFile], {
    cwd: path.join(upstreamRoot, packageEntry.packageDir)
  })
  return diffFolders(pristineDir, patchedDir)
}

export function regenerateXtermPatches({
  mode,
  repoRoot = DEFAULT_REPO_ROOT,
  workDir = path.join(tmpdir(), 'orca-xterm-patch-build'),
  log = console.info
} = {}) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, MANIFEST_RELATIVE_PATH), 'utf8'))
  assertBuildStepsAllowed(manifest)
  mkdirSync(workDir, { recursive: true })

  const lockfilePath = path.join(repoRoot, 'pnpm-lock.yaml')
  let lockfile = readFileSync(lockfilePath, 'utf8')
  let lockfileChanged = false

  const failures = []
  for (const packageEntry of manifest.packages) {
    const shortCommit = manifest.upstream.commit.slice(0, 12)
    log(`${packageEntry.name}@${packageEntry.version}: regenerating from ${shortCommit}`)
    const regenerated = regeneratePackage(packageEntry, manifest, { workDir, repoRoot })
    const patchPath = path.join(repoRoot, packageEntry.patch)
    const sourcePatchPath = path.join(repoRoot, packageEntry.sourcePatch)
    const canonicalSource = sourceHunks(regenerated)
    const packageKey = `${packageEntry.name}@${packageEntry.version}`
    const hash = patchHash(regenerated)

    if (mode === 'write') {
      writeFileSync(patchPath, regenerated)
      writeFileSync(sourcePatchPath, canonicalSource)
      log(`  wrote ${packageEntry.patch} (${Buffer.byteLength(regenerated)} bytes)`)
      log(`  wrote ${packageEntry.sourcePatch} (${Buffer.byteLength(canonicalSource)} bytes)`)
      if (readLockfilePatchHash(lockfile, packageKey) !== hash) {
        lockfile = updateLockfilePatchHash(lockfile, packageKey, hash)
        lockfileChanged = true
        log(`  updated pnpm-lock.yaml patch hash to ${hash}`)
      }
      continue
    }

    if (readLockfilePatchHash(lockfile, packageKey) !== hash) {
      failures.push(
        [
          `${packageKey}: pnpm-lock.yaml records a stale patch hash.`,
          `  lockfile: ${readLockfilePatchHash(lockfile, packageKey)}`,
          `  patch:    ${hash}`,
          '',
          'pnpm keys the patched package by the sha256 of the patch file, so',
          '`pnpm install --frozen-lockfile` will fail. Rerun with --write.'
        ].join('\n')
      )
    }

    const committed = readFileSync(patchPath, 'utf8')
    if (committed !== regenerated) {
      failures.push(
        formatCheckFailure({
          name: packageEntry.name,
          patchPath: packageEntry.patch,
          committed,
          regenerated
        })
      )
      continue
    }
    const committedSource = readFileSync(sourcePatchPath, 'utf8')
    if (committedSource !== canonicalSource) {
      failures.push(
        formatCheckFailure({
          name: packageEntry.name,
          patchPath: packageEntry.sourcePatch,
          committed: committedSource,
          regenerated: canonicalSource
        })
      )
      continue
    }
    log(`  in sync (${Buffer.byteLength(regenerated)} bytes)`)
  }

  if (lockfileChanged) {
    writeFileSync(lockfilePath, lockfile)
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n\n'))
  }
}

function main(argv) {
  const write = argv.includes('--write')
  const check = argv.includes('--check') || !write
  if (write && argv.includes('--check')) {
    throw new Error('Pass either --write or --check, not both')
  }
  const workDirArgument = argv.find((value) => value.startsWith('--work-dir='))
  regenerateXtermPatches({
    mode: write ? 'write' : 'check',
    workDir: workDirArgument ? path.resolve(workDirArgument.slice('--work-dir='.length)) : undefined
  })
  if (check) {
    console.info('xterm patches are in sync with the pinned upstream build.')
  }
}

// realpathSync so a symlinked checkout path still registers as a direct run.
const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`\n${error.message}\n`)
    process.exit(1)
  }
}
