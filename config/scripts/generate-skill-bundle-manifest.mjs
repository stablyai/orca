import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'

const SCHEMA_VERSION = 1
const SCRIPT_DIR = import.meta.dirname
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..')
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills')
const OUTPUT_ROOT = path.join(REPO_ROOT, 'resources', 'skills')
const CURRENT_MANIFEST_PATH = path.join(OUTPUT_ROOT, 'current-manifest.json')
const SNAPSHOT_REGISTRY_PATH = path.join(OUTPUT_ROOT, 'snapshot-registry.json')
const RELEASE_MAPPING_PATH = path.join(OUTPUT_ROOT, 'release-mapping.json')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareCodeUnits(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

function gitObjectSha(kind, bytes) {
  return createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest()
}

function normalizeText(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8')
}

function classifyFile(bytes) {
  if (bytes.includes(0)) {
    return 'binary'
  }
  try {
    normalizeText(bytes)
    return 'text'
  } catch {
    return 'binary'
  }
}

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
  const classification = classifyFile(bytes)
  const exactSha256 = sha256(bytes)
  const textNormalizedSha256 = classification === 'text' ? sha256(normalizeText(bytes)) : null
  return {
    path: manifestPath,
    size: bytes.length,
    executable,
    classification,
    exactSha256,
    textNormalizedSha256,
    identitySha256: classification === 'text' && !executable ? textNormalizedSha256 : exactSha256,
    gitBlobSha: gitObjectSha('blob', bytes).toString('hex')
  }
}

function gitTreeSha(entries) {
  const root = { directories: new Map(), files: [] }
  for (const entry of entries) {
    const parts = entry.path.split('/')
    const filename = parts.pop()
    let directory = root
    for (const part of parts) {
      let child = directory.directories.get(part)
      if (!child) {
        child = { directories: new Map(), files: [] }
        directory.directories.set(part, child)
      }
      directory = child
    }
    directory.files.push({ filename, ...entry })
  }

  function hashDirectory(directory) {
    const children = [
      ...[...directory.directories].map(([name, child]) => ({
        mode: '40000',
        name,
        hash: hashDirectory(child)
      })),
      ...directory.files.map((file) => ({
        mode: file.executable ? '100755' : '100644',
        name: file.filename,
        hash: Buffer.from(file.gitBlobSha, 'hex')
      }))
    ].sort((left, right) => {
      const leftName = left.mode === '40000' ? `${left.name}/` : left.name
      const rightName = right.mode === '40000' ? `${right.name}/` : right.name
      return Buffer.from(leftName).compare(Buffer.from(rightName))
    })
    const body = Buffer.concat(
      children.map(({ mode, name, hash }) =>
        Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), hash])
      )
    )
    return gitObjectSha('tree', body)
  }

  return hashDirectory(root).toString('hex')
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
      const relativePath = path.relative(packageRoot, absolutePath)
      assertSafeRelativePath(relativePath)
      const manifestPath = relativePath.split(path.sep).join('/')
      const foldedPath = manifestPath.toLocaleLowerCase('en-US')
      const collision = caseFoldedPaths.get(foldedPath)
      if (collision && collision !== manifestPath) {
        throw new Error(`Case-colliding skill paths: ${collision} and ${manifestPath}`)
      }
      caseFoldedPaths.set(foldedPath, manifestPath)
      const fileStat = await lstat(absolutePath)
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
      // a shipped skill would misclassify every pristine Windows install as unrecognized.
      if ((fileStat.mode & 0o111) !== 0) {
        throw new Error(`Executable file is not allowed in a shipped skill: ${manifestPath}`)
      }
      files.push(describeFile(manifestPath, await readFile(absolutePath), false))
    }
  }

  await visit(packageRoot)
  return sortManifestFiles(files)
}

function collectGitSkillTreeEntries(treeSha) {
  const output = execFileSync('git', ['ls-tree', '-r', '-z', treeSha])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const packages = new Map()
  for (const line of output) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/.exec(line)
    if (!match) {
      throw new Error(`Unexpected git tree entry in ${treeSha}: ${line}`)
    }
    const [, mode, type, objectSha, sourcePath] = match
    const separator = sourcePath.indexOf('/')
    if (separator <= 0 || separator === sourcePath.length - 1) {
      throw new Error(`Unsupported shipped skill path in ${treeSha}: ${sourcePath}`)
    }
    const name = sourcePath.slice(0, separator)
    const manifestPath = sourcePath.slice(separator + 1)
    const entries = packages.get(name) ?? []
    entries.push({ mode, type, objectSha, manifestPath })
    packages.set(name, entries)
  }
  return packages
}

function readGitBlobs(objectShas) {
  const uniqueShas = [...new Set(objectShas)]
  if (uniqueShas.length === 0) {
    return new Map()
  }
  // Why: released history spans hundreds of tags. Batch mode avoids a Git
  // subprocess per historical file while remaining available on Git 2.25.
  const output = execFileSync('git', ['cat-file', '--batch'], {
    input: `${uniqueShas.join('\n')}\n`,
    maxBuffer: 64 * 1024 * 1024
  })
  const blobs = new Map()
  let offset = 0
  for (const requestedSha of uniqueShas) {
    const headerEnd = output.indexOf(10, offset)
    if (headerEnd < 0) {
      throw new Error(`Missing git cat-file header for ${requestedSha}`)
    }
    const header = output.subarray(offset, headerEnd).toString('utf8')
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header)
    if (!match || match[1] !== requestedSha) {
      throw new Error(`Unexpected git cat-file header for ${requestedSha}: ${header}`)
    }
    const size = Number(match[2])
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    if (contentEnd >= output.length || output[contentEnd] !== 10) {
      throw new Error(`Truncated git blob for ${requestedSha}`)
    }
    blobs.set(requestedSha, Buffer.from(output.subarray(contentStart, contentEnd)))
    offset = contentEnd + 1
  }
  return blobs
}

function collectGitPackageFiles(treeSha, name, entries, blobs) {
  const caseFoldedPaths = new Map()
  const files = entries.map(({ mode, type, objectSha, manifestPath }) => {
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      throw new Error(`Unsupported shipped skill entry in ${treeSha}: ${name}/${manifestPath}`)
    }
    assertSafeRelativePath(manifestPath)
    const foldedPath = manifestPath.toLocaleLowerCase('en-US')
    const collision = caseFoldedPaths.get(foldedPath)
    if (collision && collision !== manifestPath) {
      throw new Error(`Case-colliding skill paths in ${treeSha}: ${collision} and ${manifestPath}`)
    }
    caseFoldedPaths.set(foldedPath, manifestPath)
    const bytes = blobs.get(objectSha)
    if (!bytes) {
      throw new Error(`Missing git blob ${objectSha} for ${name}/${manifestPath}`)
    }
    return describeFile(manifestPath, bytes, mode === '100755')
  })
  // Why: git ls-tree emits git byte-order, not the canonical walk order.
  return sortManifestFiles(files)
}

// Why: snapshot matching compares files by array index, so every producer —
// working-tree walk, git history, and runtime observation — must emit one
// canonical order. This mirrors the sorted depth-first filesystem walk.
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

function releaseTags() {
  return execFileSync(
    'git',
    ['for-each-ref', '--sort=creatordate', '--format=%(refname:short)', 'refs/tags/v*'],
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(tag))
}

function skillsTreeShasAtRefs(refs) {
  if (refs.length === 0) {
    return []
  }
  const output = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: `${refs.map((ref) => `${ref}:skills`).join('\n')}\n`,
    encoding: 'utf8'
  })
  const lines = output.trimEnd().split('\n')
  if (lines.length !== refs.length) {
    throw new Error(`Expected ${refs.length} skills tree identities, received ${lines.length}`)
  }
  return lines.map((line, index) => {
    if (line.endsWith(' missing')) {
      return null
    }
    const match = /^([a-f0-9]+) tree$/.exec(line)
    if (!match) {
      throw new Error(`Unexpected skills tree identity at ${refs[index]}: ${line}`)
    }
    return match[1]
  })
}

function buildReleasedHistory() {
  const registry = { schemaVersion: SCHEMA_VERSION, skills: {} }
  const mapping = { schemaVersion: SCHEMA_VERSION, releases: [] }
  const tags = releaseTags()
  const treeShas = skillsTreeShasAtRefs(tags)
  const distinctTreeShas = [...new Set(treeShas.filter(Boolean))]
  const packagesByTree = new Map(
    distinctTreeShas.map((treeSha) => [treeSha, collectGitSkillTreeEntries(treeSha)])
  )
  const blobs = readGitBlobs(
    [...packagesByTree.values()].flatMap((packages) =>
      [...packages.values()].flatMap((entries) => entries.map((entry) => entry.objectSha))
    )
  )
  let previousSkillsTreeSha = null
  for (const [index, tag] of tags.entries()) {
    const skillsTreeSha = treeShas[index]
    if (!skillsTreeSha || skillsTreeSha === previousSkillsTreeSha) {
      continue
    }
    previousSkillsTreeSha = skillsTreeSha
    const revisions = {}
    const packages = packagesByTree.get(skillsTreeSha)
    if (!packages) {
      throw new Error(`Missing released skill tree ${skillsTreeSha} at ${tag}`)
    }
    for (const name of [...packages.keys()].sort(compareCodeUnits)) {
      const entries = packages.get(name)
      const filesWithGitHashes = collectGitPackageFiles(skillsTreeSha, name, entries, blobs)
      if (!filesWithGitHashes.some((file) => file.path === 'SKILL.md')) {
        continue
      }
      const digest = packageDigest(filesWithGitHashes)
      const snapshots = registry.skills[name] ?? []
      const latest = snapshots.at(-1)
      if (!latest || latest.packageDigest !== digest) {
        const files = filesWithGitHashes.map(({ gitBlobSha: _gitBlobSha, ...file }) => file)
        snapshots.push({
          releaseRevision: (latest?.releaseRevision ?? 0) + 1,
          packageDigest: digest,
          gitTreeSha: gitTreeSha(filesWithGitHashes),
          files
        })
        registry.skills[name] = snapshots
      }
      revisions[name] = snapshots.at(-1).releaseRevision
    }
    if (Object.keys(revisions).length > 0) {
      mapping.releases.push({ appVersion: tag.slice(1), skills: revisions })
    }
  }
  return { registry, mapping }
}

async function buildArtifacts(appVersion) {
  const { registry, mapping } = buildReleasedHistory()
  const releasedSnapshotCounts = Object.fromEntries(
    Object.entries(registry.skills).map(([name, snapshots]) => [name, snapshots.length])
  )
  const skillDirectories = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnits)
  const currentSkills = []
  for (const name of skillDirectories) {
    const filesWithGitHashes = await collectPackageFiles(path.join(SKILLS_ROOT, name))
    if (!filesWithGitHashes.some((file) => file.path === 'SKILL.md')) {
      throw new Error(`Skill package ${name} has no top-level SKILL.md`)
    }
    const digest = packageDigest(filesWithGitHashes)
    const snapshots = registry.skills[name] ?? []
    const latest = snapshots.at(-1)
    let snapshot = latest
    if (!latest || latest.packageDigest !== digest) {
      const files = filesWithGitHashes.map(({ gitBlobSha: _gitBlobSha, ...file }) => file)
      snapshot = {
        releaseRevision: (latest?.releaseRevision ?? 0) + 1,
        packageDigest: digest,
        gitTreeSha: gitTreeSha(filesWithGitHashes),
        files
      }
      snapshots.push(snapshot)
      registry.skills[name] = snapshots
    }
    currentSkills.push({
      name,
      sourcePath: `skills/${name}`,
      appVersion,
      ...snapshot
    })
  }
  return {
    currentManifest: {
      schemaVersion: SCHEMA_VERSION,
      appVersion,
      skills: currentSkills
    },
    snapshotRegistry: registry,
    releaseMapping: mapping,
    releasedSnapshotCounts
  }
}

// Why: released snapshots are the detection ground truth for existing installs,
// so a generation-logic change must not rewrite them silently. Only the one
// unreleased working-tree append per skill may change between runs.
function assertReleasedHistoryPreserved(committedRegistry, artifacts) {
  if (!committedRegistry || committedRegistry.schemaVersion !== SCHEMA_VERSION) {
    return
  }
  for (const [name, committedSnapshots] of Object.entries(committedRegistry.skills ?? {})) {
    const releasedCount = artifacts.releasedSnapshotCounts[name] ?? 0
    const regenerated = artifacts.snapshotRegistry.skills[name] ?? []
    if (releasedCount < Math.max(0, committedSnapshots.length - 1)) {
      throw new Error(
        `Released snapshot history is incomplete for ${name}. ` +
          'Fetch all release tags before regenerating skill artifacts.'
      )
    }
    const protectedCount = Math.min(committedSnapshots.length, releasedCount)
    for (let index = 0; index < protectedCount; index += 1) {
      const committed = committedSnapshots[index]
      const rebuilt = regenerated[index]
      if (!rebuilt || !isDeepStrictEqual(rebuilt, committed)) {
        throw new Error(
          `Released snapshot history changed for ${name} at revision ${committed.releaseRevision}. ` +
            'Released snapshots are append-only; a deliberate identity migration must update this check.'
        )
      }
    }
  }
}

async function readCommittedRegistry() {
  try {
    return JSON.parse(await readFile(SNAPSHOT_REGISTRY_PATH, 'utf8'))
  } catch {
    return null
  }
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function writeArtifacts(artifacts) {
  await mkdir(OUTPUT_ROOT, { recursive: true })
  await Promise.all([
    writeFile(CURRENT_MANIFEST_PATH, serialized(artifacts.currentManifest)),
    writeFile(SNAPSHOT_REGISTRY_PATH, serialized(artifacts.snapshotRegistry)),
    writeFile(RELEASE_MAPPING_PATH, serialized(artifacts.releaseMapping))
  ])
}

async function verifyArtifacts(artifacts) {
  const expected = [
    [CURRENT_MANIFEST_PATH, artifacts.currentManifest],
    [SNAPSHOT_REGISTRY_PATH, artifacts.snapshotRegistry],
    [RELEASE_MAPPING_PATH, artifacts.releaseMapping]
  ]
  const stale = []
  for (const [filePath, value] of expected) {
    try {
      await access(filePath, constants.R_OK)
      if ((await readFile(filePath, 'utf8')) !== serialized(value)) {
        stale.push(filePath)
      }
    } catch {
      stale.push(filePath)
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Generated skill artifacts are stale:\n${stale
        .map((filePath) => path.relative(REPO_ROOT, filePath))
        .join('\n')}\nRun pnpm generate:skill-bundle-manifest.`
    )
  }
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  const artifacts = await buildArtifacts(packageJson.version)
  assertReleasedHistoryPreserved(await readCommittedRegistry(), artifacts)
  await (process.argv.includes('--write') ? writeArtifacts : verifyArtifacts)(artifacts)
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}

export {
  assertReleasedHistoryPreserved,
  buildArtifacts,
  buildReleasedHistory,
  classifyFile,
  collectPackageFiles,
  describeFile,
  gitTreeSha,
  normalizeText,
  packageDigest,
  sortManifestFiles,
  verifyArtifacts,
  writeArtifacts
}
