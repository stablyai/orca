const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, readdirSync } = require('node:fs')
const { basename, join } = require('node:path')
const {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_BUN_RUNTIME_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  orcadArtifactFilenames
} = require('../../src/shared/orcad-artifacts.ts')
const { ORCAD_BUN_TARGETS } = require('../../src/shared/orcad-bun-runtime.ts')

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BROWSER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function readManifest(templateDir) {
  const path = join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `[verify-packaged-orcad-template] invalid manifest at ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function requireRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[verify-packaged-orcad-template] ${label} must be an object`)
  }
  return value
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`[verify-packaged-orcad-template] ${label} must be a SHA-256 digest`)
  }
  return value
}

function requireRegularFile(path, label) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch {
    throw new Error(`[verify-packaged-orcad-template] missing ${label} at ${path}`)
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`[verify-packaged-orcad-template] ${label} is not a regular file at ${path}`)
  }
}

function verifyFile(path, expected, label) {
  requireRegularFile(path, label)
  const actual = sha256(path)
  if (actual !== expected) {
    throw new Error(
      `[verify-packaged-orcad-template] ${label} checksum mismatch: expected ${expected}, got ${actual}`
    )
  }
}

function requireExactNames(actual, expected, label) {
  const actualNames = [...actual].sort()
  const expectedNames = [...expected].sort()
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      `[verify-packaged-orcad-template] ${label} mismatch: expected=${expectedNames.join(',')} actual=${actualNames.join(',')}`
    )
  }
}

function verifyTarget(templateDir, target, value) {
  const targetManifest = requireRecord(value, `${target} manifest`)
  const targetSha256 = requireSha256(targetManifest.targetSha256, `${target} targetSha256`)
  const watcherSha256 = requireSha256(targetManifest.watcherSha256, `${target} watcherSha256`)
  const hasBrowserName = Object.hasOwn(targetManifest, 'browserName')
  const hasBrowserSha256 = Object.hasOwn(targetManifest, 'browserSha256')
  if (hasBrowserName !== hasBrowserSha256) {
    throw new Error(
      `[verify-packaged-orcad-template] ${target} browserName and browserSha256 must both be present`
    )
  }
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetIdentity = join(targetDir, ORCAD_BUILD_TARGET_FILENAME)
  verifyFile(targetIdentity, targetSha256, `${target} build target`)
  if (readFileSync(targetIdentity, 'utf8').trim() !== target) {
    throw new Error(`[verify-packaged-orcad-template] ${target} build target identity disagrees`)
  }
  verifyFile(join(targetDir, 'watcher.node'), watcherSha256, `${target} watcher`)

  const expectedFiles = [ORCAD_BUILD_TARGET_FILENAME, 'watcher.node']
  if (hasBrowserName) {
    const browserName = targetManifest.browserName
    if (
      typeof browserName !== 'string' ||
      !BROWSER_NAME_PATTERN.test(browserName) ||
      basename(browserName) !== browserName
    ) {
      throw new Error(`[verify-packaged-orcad-template] ${target} browserName is invalid`)
    }
    verifyFile(
      join(targetDir, browserName),
      requireSha256(targetManifest.browserSha256, `${target} browserSha256`),
      `${target} browser`
    )
    expectedFiles.push(browserName)
  }
  requireExactNames(readdirSync(targetDir), expectedFiles, `${target} file inventory`)
}

function verifyPackagedOrcadTemplate(resourcesDir) {
  const templateDir = join(resourcesDir, 'orcad-template')
  const manifest = requireRecord(readManifest(templateDir), 'manifest')
  if (manifest.schemaVersion !== 2) {
    throw new Error('[verify-packaged-orcad-template] manifest schemaVersion must be 2')
  }
  const commonSha256 = requireRecord(manifest.commonSha256, 'commonSha256')
  const commonFilenames = orcadArtifactFilenames().filter(
    (filename) =>
      filename !== ORCAD_BUN_RUNTIME_FILENAME &&
      filename !== ORCAD_BUILD_TARGET_FILENAME &&
      !filename.endsWith('watcher.node')
  )
  requireExactNames(Object.keys(commonSha256), commonFilenames, 'common manifest inventory')
  for (const filename of commonFilenames) {
    verifyFile(
      join(templateDir, ...filename.split('/')),
      requireSha256(commonSha256[filename], `${filename} checksum`),
      filename
    )
  }

  const targets = requireRecord(manifest.targets, 'targets')
  requireExactNames(Object.keys(targets), ORCAD_BUN_TARGETS, 'target manifest inventory')
  requireExactNames(
    readdirSync(join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR)),
    ORCAD_BUN_TARGETS,
    'target directory inventory'
  )
  for (const target of ORCAD_BUN_TARGETS) {
    verifyTarget(templateDir, target, targets[target])
  }
  console.log(
    `[verify-packaged-orcad-template] OK — verified ${ORCAD_BUN_TARGETS.length} Bun targets`
  )
}

module.exports = { verifyPackagedOrcadTemplate }
