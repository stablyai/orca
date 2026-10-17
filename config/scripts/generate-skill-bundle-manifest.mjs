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
// Why append-only: Orca replaces an installed copy only when its bytes match a version some
// build shipped, so removing a digest would strand every user still on that version.
const RELEASED_DIGESTS_PATH = path.join(OUTPUT_ROOT, 'released-digests.json')
const EMBEDDED_PACKAGES_PATH = path.join(
  REPO_ROOT,
  'src',
  'main',
  'skills',
  'bundled-orca-skill-packages.ts'
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

async function readReleasedDigests() {
  const text = await readFile(RELEASED_DIGESTS_PATH, 'utf8').catch(() => null)
  return text === null ? { schemaVersion: 1, skills: {} } : JSON.parse(text)
}

function withDigests(ledger, additions) {
  const skills = { ...ledger.skills }
  for (const [name, digests] of additions) {
    skills[name] = [...new Set([...(skills[name] ?? []), ...digests])]
  }
  const names = Object.keys(skills).sort(compareCodeUnits)
  return { schemaVersion: 1, skills: Object.fromEntries(names.map((name) => [name, skills[name]])) }
}

function withCurrentDigests(ledger, manifest) {
  return withDigests(
    ledger,
    manifest.skills.map((skill) => [skill.name, [skill.packageDigest]])
  )
}

// Why embedded: `orca skills install` runs on hosts with no app resources directory, so
// the installable bytes ship inside the code, as the guides do.
async function buildEmbeddedPackages(manifest, ledger) {
  const packages = []
  for (const skill of manifest.skills) {
    const files = []
    for (const file of skill.files) {
      if (file.classification !== 'text') {
        throw new Error(`Bundled install supports text files only: ${skill.name}/${file.path}`)
      }
      const bytes = await readFile(path.join(REPO_ROOT, skill.sourcePath, ...file.path.split('/')))
      files.push({ path: file.path, text: normalizeText(bytes).toString('utf8') })
    }
    packages.push({ name: skill.name, files, releasedDigests: ledger.skills[skill.name] })
  }
  const entries = packages.map((entry) => `  ${JSON.stringify(entry)}`).join(',\n')
  return (
    '// Generated by config/scripts/generate-skill-bundle-manifest.mjs. Do not edit.\n\n' +
    'export type BundledOrcaSkillFile = {\n  readonly path: string\n  readonly text: string\n}\n\n' +
    'export type BundledOrcaSkillPackage = {\n  readonly name: string\n' +
    '  readonly files: readonly BundledOrcaSkillFile[]\n' +
    '  /** Every package digest a build has shipped for this name, this build included. */\n' +
    '  readonly releasedDigests: readonly string[]\n}\n\n' +
    '// oxfmt-ignore\n' +
    `export const BUNDLED_ORCA_SKILL_PACKAGES: readonly BundledOrcaSkillPackage[] = [\n${entries}\n]\n`
  )
}

function git(args, encoding) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

// Why: seeds the ledger from one bounded path history per shipped skill, never a ref scan.
function historicalDigests(skill) {
  const commits = git(['log', '--reverse', '--format=%H', 'HEAD', '--', skill.sourcePath], 'utf8')
    .split('\n')
    .filter(Boolean)
  const digests = []
  for (const commit of commits) {
    // `<mode> <type> <object>\t<path>`; 100755 is the executable bit the copy carried.
    const entries = git(['ls-tree', '-r', commit, '--', `${skill.sourcePath}/`], 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [meta, filePath] = line.split('\t')
        return { executable: meta.startsWith('100755 '), filePath }
      })
    if (!entries.some((entry) => entry.filePath === `${skill.sourcePath}/SKILL.md`)) {
      continue
    }
    const files = entries
      .map((entry) => ({
        ...entry,
        relativePath: entry.filePath.slice(skill.sourcePath.length + 1)
      }))
      .filter(({ relativePath }) => !isOsMetadataSkillEntryName(path.posix.basename(relativePath)))
      .map(({ relativePath, filePath, executable }) =>
        describeFile(relativePath, git(['show', `${commit}:${filePath}`]), executable)
      )
    digests.push(packageDigest(sortManifestFiles(files)))
  }
  return digests
}

function tryGit(args) {
  try {
    return git(args, 'utf8')
  } catch {
    return null
  }
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

/** Every digest the base branch knew must survive; the ledger only grows. */
export function findDroppedReleasedDigests(baseLedger, ledger) {
  return Object.entries(baseLedger.skills ?? {}).flatMap(([name, digests]) =>
    digests
      .filter((digest) => !(ledger.skills[name] ?? []).includes(digest))
      .map((digest) => `${name}:${digest}`)
  )
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
      `${relativePath} dropped digests its base shipped (it is append-only):\n${dropped.join('\n')}`
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
  const args = process.argv.slice(2)
  const manifest = await buildCurrentManifest()
  const backfill = args.includes('--backfill-released-digests')
  const committedLedger = await readReleasedDigests()
  const ledger = withCurrentDigests(
    backfill
      ? withDigests(
          committedLedger,
          manifest.skills.map((skill) => [skill.name, historicalDigests(skill)])
        )
      : committedLedger,
    manifest
  )
  const embedded = await buildEmbeddedPackages(manifest, ledger)
  if (args.includes('--write') || backfill) {
    await mkdir(OUTPUT_ROOT, { recursive: true })
    await mkdir(path.dirname(EMBEDDED_PACKAGES_PATH), { recursive: true })
    await writeFile(CURRENT_MANIFEST_PATH, serialized(manifest))
    await writeFile(RELEASED_DIGESTS_PATH, serialized(ledger))
    await writeFile(EMBEDDED_PACKAGES_PATH, embedded)
    return
  }
  await verifyGeneratedFile(CURRENT_MANIFEST_PATH, serialized(manifest))
  await verifyGeneratedFile(RELEASED_DIGESTS_PATH, serialized(ledger))
  verifyLedgerKeepsBase(ledger)
  await verifyGeneratedFile(EMBEDDED_PACKAGES_PATH, embedded)
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

export {
  buildCurrentManifest,
  withDigests,
  classifyFile,
  collectPackageFiles,
  describeFile,
  normalizeText,
  packageDigest,
  sortManifestFiles
}
