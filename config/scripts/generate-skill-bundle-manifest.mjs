import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'

// Why: schema 3 dropped release revisions and git tree identity along with the snapshot
// registry. Freshness compares installed copies against these bytes only.
const CURRENT_MANIFEST_SCHEMA_VERSION = 3
const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills')
const OUTPUT_ROOT = path.join(REPO_ROOT, 'resources', 'skills')
const CURRENT_MANIFEST_PATH = path.join(OUTPUT_ROOT, 'current-manifest.json')
// Why add-only: a copy counts as Orca's untouched install only while its SKILL.md digest is
// listed, so dropping one would strand every user still on that version.
const RELEASED_DIGESTS_PATH = path.join(OUTPUT_ROOT, 'released-digests.json')
const BUNDLED_SOURCES_PATH = path.join(
  REPO_ROOT,
  'src',
  'main',
  'skills',
  'bundled-skill-install',
  'bundled-skill-sources.ts'
)

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareCodeUnits(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function normalizeText(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
}

function normalizedTextOrNull(bytes) {
  if (bytes.includes(0)) {
    return null
  }
  try {
    return normalizeText(bytes)
  } catch {
    return null
  }
}

const classifyFile = (bytes) => (normalizedTextOrNull(bytes) === null ? 'binary' : 'text')

function assertSafeRelativePath(relativePath) {
  if (
    path.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Unsafe skill package path: ${relativePath}`)
  }
}

function describeFile(manifestPath, bytes, executable) {
  const normalized = normalizedTextOrNull(bytes)
  const exactSha256 = sha256(bytes)
  const textNormalizedSha256 = normalized === null ? null : sha256(normalized)
  return {
    path: manifestPath,
    size: bytes.length,
    executable,
    classification: normalized === null ? 'binary' : 'text',
    exactSha256,
    textNormalizedSha256,
    identitySha256: normalized !== null && !executable ? textNormalizedSha256 : exactSha256
  }
}

// Why: kept in step with isOsMetadataSkillEntryName in src/main/skills/skill-package-identity.ts.
// The scanner ignores these because the OS writes them into a live install; the generator
// ignores them so a stray one in a working tree cannot be committed into the manifest as
// content no user could ever match. Skipped rather than rejected: the file is not the
// developer's doing, so failing the build over it would be hostile.
const OS_METADATA_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini'])

function isOsMetadataSkillEntryName(name) {
  const folded = name.toLocaleLowerCase('en-US')
  return OS_METADATA_FILE_NAMES.has(folded) || folded.startsWith('._')
}

async function collectPackageFiles(packageRoot) {
  const files = []
  const caseFoldedPaths = new Map()

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    // Why: build-time Node and packaged Electron may ship different ICU data;
    // package identity order must use the same locale-independent comparison.
    entries.sort((left, right) => compareCodeUnits(left.name, right.name))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const fileStat = await lstat(absolutePath)
      // Only a plain file is OS-authored, so the type decides and not the name alone: a
      // directory or link wearing the name would otherwise drop its subtree out of the
      // manifest and skip the guards below. Decided before the case-fold map so two
      // spellings of one sidecar cannot collide.
      if (isOsMetadataSkillEntryName(entry.name) && fileStat.isFile()) {
        continue
      }
      const relativePath = path.relative(packageRoot, absolutePath)
      assertSafeRelativePath(relativePath)
      const manifestPath = relativePath.split(path.sep).join('/')
      const foldedPath = manifestPath.toLocaleLowerCase('en-US')
      const collision = caseFoldedPaths.get(foldedPath)
      if (collision && collision !== manifestPath) {
        throw new Error(`Case-colliding skill paths: ${collision} and ${manifestPath}`)
      }
      caseFoldedPaths.set(foldedPath, manifestPath)
      if (fileStat.isSymbolicLink()) {
        throw new Error(`Symlink is not allowed in a shipped skill: ${manifestPath}`)
      }
      if (fileStat.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!fileStat.isFile()) {
        throw new Error(`Special file is not allowed in a shipped skill: ${manifestPath}`)
      }
      // Why: Windows observation cannot see execute bits, so an executable file in
      // a shipped skill would misclassify every pristine Windows install as outdated.
      if ((fileStat.mode & 0o111) !== 0) {
        throw new Error(`Executable file is not allowed in a shipped skill: ${manifestPath}`)
      }
      files.push(describeFile(manifestPath, await readFile(absolutePath), false))
    }
  }

  await visit(packageRoot)
  return sortManifestFiles(files)
}

// Why: the package digest hashes files in array order, so the generator and runtime
// observation must emit one canonical order: the sorted depth-first filesystem walk.
function compareManifestPaths(left, right) {
  const leftParts = left.split('/')
  const rightParts = right.split('/')
  const shared = Math.min(leftParts.length, rightParts.length)
  for (let index = 0; index < shared; index += 1) {
    const order = compareCodeUnits(leftParts[index], rightParts[index])
    if (order !== 0) {
      return order
    }
  }
  return leftParts.length - rightParts.length
}

function sortManifestFiles(files) {
  return [...files].sort((left, right) => compareManifestPaths(left.path, right.path))
}

function packageDigest(files) {
  return sha256(
    Buffer.from(
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          executable: file.executable,
          classification: file.classification,
          identitySha256: file.identitySha256
        }))
      ),
      'utf8'
    )
  )
}

async function buildCurrentManifest() {
  const skillDirectories = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnits)
  const skills = []
  for (const name of skillDirectories) {
    const files = await collectPackageFiles(path.join(SKILLS_ROOT, name))
    if (!files.some((file) => file.path === 'SKILL.md')) {
      throw new Error(`Skill package ${name} has no top-level SKILL.md`)
    }
    skills.push({ name, sourcePath: `skills/${name}`, packageDigest: packageDigest(files), files })
  }
  return { schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION, skills }
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function textDigest(bytes) {
  const normalized = normalizedTextOrNull(bytes)
  return normalized === null ? null : sha256(normalized)
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options
  })
}

function tryGit(args, options) {
  try {
    return git(args, { encoding: 'utf8', ...options })
  } catch {
    return null
  }
}

const SKILL_FILE_RAW_LINE = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*\tskills\/([^/]+)\/SKILL\.md$/u

/** Every `skills/<name>/SKILL.md` blob reachable from HEAD; empty outside a git checkout. */
function historicalSkillDigests() {
  // One path-limited log plus one batched read: never a per-commit or per-ref fan-out.
  const log = tryGit([
    'log',
    '--format=',
    '--raw',
    '--no-abbrev',
    '--no-renames',
    'HEAD',
    '--',
    'skills'
  ])
  if (log === null) {
    return []
  }
  const namesByBlob = new Map()
  for (const line of log.split('\n')) {
    const match = SKILL_FILE_RAW_LINE.exec(line)
    if (match && !/^0+$/u.test(match[1])) {
      namesByBlob.set(match[1], match[2])
    }
  }
  if (namesByBlob.size === 0) {
    return []
  }
  const batch = git(['cat-file', '--batch'], { input: `${[...namesByBlob.keys()].join('\n')}\n` })
  const digests = []
  for (let offset = 0; offset < batch.length;) {
    const headerEnd = batch.indexOf(0x0a, offset)
    const [blob, , size] = batch.subarray(offset, headerEnd).toString('utf8').split(' ')
    const bytes = batch.subarray(headerEnd + 1, headerEnd + 1 + Number(size))
    offset = headerEnd + 1 + Number(size) + 1
    const digest = textDigest(bytes)
    if (digest !== null) {
      digests.push([namesByBlob.get(blob), [digest]])
    }
  }
  return digests
}

function withDigests(ledger, additions) {
  const skills = { ...ledger.skills }
  for (const [name, digests] of additions) {
    skills[name] = [...new Set([...(skills[name] ?? []), ...digests])].sort(compareCodeUnits)
  }
  const names = Object.keys(skills).sort(compareCodeUnits)
  return { schemaVersion: 1, skills: Object.fromEntries(names.map((name) => [name, skills[name]])) }
}

/** Digests a base ledger listed that this one lost. */
function findDroppedReleasedDigests(baseLedger, ledger) {
  return Object.entries(baseLedger.skills ?? {}).flatMap(([name, digests]) =>
    digests
      .filter((digest) => !(ledger.skills[name] ?? []).includes(digest))
      .map((digest) => `${name}:${digest}`)
  )
}

async function readReleasedDigests() {
  const text = await readFile(RELEASED_DIGESTS_PATH, 'utf8').catch(() => null)
  return text === null ? { schemaVersion: 1, skills: {} } : JSON.parse(text)
}

async function buildReleasedDigests(manifest) {
  const current = []
  for (const skill of manifest.skills) {
    const bytes = await readFile(path.join(REPO_ROOT, skill.sourcePath, 'SKILL.md'))
    current.push([skill.name, [textDigest(bytes)]])
  }
  return withDigests(await readReleasedDigests(), [...historicalSkillDigests(), ...current])
}

// Why embedded: `orca skills install` and paired servers run with no app resources folder,
// so the installable bytes ship inside the code, as the skill guides do.
async function buildBundledSources(manifest, ledger) {
  const sources = []
  for (const skill of manifest.skills) {
    // The installer's untouched-copy rule is "the folder holds exactly SKILL.md".
    if (skill.files.length !== 1 || skill.files[0].classification !== 'text') {
      throw new Error(`Bundled skills ship a single text SKILL.md: ${skill.name}`)
    }
    const bytes = await readFile(path.join(REPO_ROOT, skill.sourcePath, 'SKILL.md'))
    sources.push({
      name: skill.name,
      text: normalizeText(bytes).toString('utf8'),
      releasedDigests: ledger.skills[skill.name]
    })
  }
  return (
    '// Generated by config/scripts/generate-skill-bundle-manifest.mjs. Do not edit.\n\n' +
    'export type BundledSkillSource = {\n' +
    '  readonly name: string\n' +
    '  /** LF-normalised `SKILL.md`, the only file a bundled skill ships. */\n' +
    '  readonly text: string\n' +
    '  /** sha256 of every LF-normalised `SKILL.md` any build shipped, this one included. */\n' +
    '  readonly releasedDigests: readonly string[]\n' +
    '}\n\n' +
    '// oxfmt-ignore\n' +
    'export const BUNDLED_SKILL_SOURCES: readonly BundledSkillSource[] = [\n' +
    `${sources.map((source) => `  ${JSON.stringify(source)}`).join(',\n')}\n]\n`
  )
}

// Why: on a PR merge ref HEAD^1 is the base; locally, the merge base with main.
function ledgerBaseCommit() {
  try {
    return (
      resolvePullRequestDiffBase(REPO_ROOT, null) ??
      (tryGit(['merge-base', 'origin/main', 'HEAD'])?.trim() || null)
    )
  } catch {
    return null
  }
}

function verifyLedgerKeepsBase(ledger) {
  const base = ledgerBaseCommit()
  const relativePath = path.relative(REPO_ROOT, RELEASED_DIGESTS_PATH).split(path.sep).join('/')
  // Why fail closed on a PR: an unreadable base would otherwise let a shrink through silently.
  if (
    process.env.GITHUB_EVENT_NAME === 'pull_request' &&
    (!base || tryGit(['cat-file', '-e', base]) === null)
  ) {
    throw new Error(`Cannot read the pull request base to check ${relativePath} only grows.`)
  }
  const baseText = base ? tryGit(['show', `${base}:${relativePath}`]) : null
  if (baseText === null) {
    return
  }
  const dropped = findDroppedReleasedDigests(JSON.parse(baseText), ledger)
  if (dropped.length > 0) {
    throw new Error(
      `${relativePath} dropped digests its base shipped (it is add-only):\n${dropped.join('\n')}`
    )
  }
}

async function verifyGeneratedFile(filePath, expected) {
  const committedText = await readFile(filePath, 'utf8').catch(() => null)
  if (committedText !== expected) {
    throw new Error(
      `Generated skill bundle artifact is stale:\n${path.relative(REPO_ROOT, filePath)}\n` +
        'Run pnpm generate:skill-bundle-manifest.'
    )
  }
}

async function main() {
  const manifest = await buildCurrentManifest()
  const ledger = await buildReleasedDigests(manifest)
  const sources = await buildBundledSources(manifest, ledger)
  if (process.argv.slice(2).includes('--write')) {
    await mkdir(OUTPUT_ROOT, { recursive: true })
    await mkdir(path.dirname(BUNDLED_SOURCES_PATH), { recursive: true })
    await writeFile(CURRENT_MANIFEST_PATH, serialized(manifest))
    await writeFile(RELEASED_DIGESTS_PATH, serialized(ledger))
    await writeFile(BUNDLED_SOURCES_PATH, sources)
    return
  }
  await verifyGeneratedFile(CURRENT_MANIFEST_PATH, serialized(manifest))
  // Equal to its own union with history and the current bytes means none is missing.
  await verifyGeneratedFile(RELEASED_DIGESTS_PATH, serialized(ledger))
  verifyLedgerKeepsBase(ledger)
  await verifyGeneratedFile(BUNDLED_SOURCES_PATH, sources)
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

export {
  buildCurrentManifest,
  classifyFile,
  collectPackageFiles,
  describeFile,
  findDroppedReleasedDigests,
  normalizeText,
  packageDigest,
  sortManifestFiles,
  withDigests
}
