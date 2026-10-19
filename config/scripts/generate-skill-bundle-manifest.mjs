import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

// Why: schema 3 dropped release revisions and git tree identity along with the snapshot
// registry. Freshness compares installed copies against these bytes only.
const CURRENT_MANIFEST_SCHEMA_VERSION = 3
const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills')
const OUTPUT_ROOT = path.join(REPO_ROOT, 'resources', 'skills')
const CURRENT_MANIFEST_PATH = path.join(OUTPUT_ROOT, 'current-manifest.json')

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

async function verifyCurrentManifest(manifest) {
  const committedText = await readFile(CURRENT_MANIFEST_PATH, 'utf8').catch(() => null)
  if (committedText !== serialized(manifest)) {
    throw new Error(
      `Generated skill manifest is stale:\n${path.relative(REPO_ROOT, CURRENT_MANIFEST_PATH)}\n` +
        'Run pnpm generate:skill-bundle-manifest.'
    )
  }
}

async function main() {
  const manifest = await buildCurrentManifest()
  if (process.argv.slice(2).includes('--write')) {
    await mkdir(OUTPUT_ROOT, { recursive: true })
    await writeFile(CURRENT_MANIFEST_PATH, serialized(manifest))
    return
  }
  await verifyCurrentManifest(manifest)
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
  normalizeText,
  packageDigest,
  sortManifestFiles
}
