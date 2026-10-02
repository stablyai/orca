const { createHash } = require('node:crypto')
const { lstatSync, readFileSync, readdirSync } = require('node:fs')
const { basename, join, relative, sep } = require('node:path')
const {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  orcadTemplateCommonFilenames,
  orcadTemplateTargetFilenames
} = require('../../src/shared/orcad-artifacts.ts')
const {
  COMPAT_SERVER_TARGETS,
  ORCAD_TEMPLATE_TARGETS,
  pinnedNodeRuntimeAsset
} = require('../../src/shared/node-runtime-pin.ts')

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const BROWSER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TEMPLATE_SCHEMA_VERSION = 3

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

function listFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
}

function requireContent(path, expected, label) {
  if (readFileSync(path, 'utf8').trim() !== expected) {
    throw new Error(`[verify-packaged-orcad-template] ${label} disagrees`)
  }
}

function verifyTarget(templateDir, target, value) {
  const targetManifest = requireRecord(value, `${target} manifest`)
  const files = requireRecord(targetManifest.files, `${target} files`)
  const expectedFiles = orcadTemplateTargetFilenames(target)
  requireExactNames(Object.keys(files), expectedFiles, `${target} manifest inventory`)
  const hasBrowserName = Object.hasOwn(targetManifest, 'browserName')
  const hasBrowserSha256 = Object.hasOwn(targetManifest, 'browserSha256')
  if (hasBrowserName !== hasBrowserSha256) {
    throw new Error(
      `[verify-packaged-orcad-template] ${target} browserName and browserSha256 must both be present`
    )
  }
  const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  for (const filename of expectedFiles) {
    verifyFile(
      join(targetDir, ...filename.split('/')),
      requireSha256(files[filename], `${target} ${filename} checksum`),
      `${target} ${filename}`
    )
  }
  requireContent(join(targetDir, ORCAD_SERVER_TARGET_FILENAME), target, `${target} server target`)
  requireContent(
    join(targetDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME),
    pinnedNodeRuntimeAsset(target).executableSha256,
    `${target} runtime reference`
  )

  const inventory = [...expectedFiles]
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
    inventory.push(browserName)
  }
  requireExactNames(listFiles(targetDir), inventory, `${target} file inventory`)
}

/** `targets` narrows the inventory for a CI-only partial template; packaging checks them all. */
function verifyPackagedOrcadTemplate(resourcesDir, targets = ORCAD_TEMPLATE_TARGETS) {
  const templateDir = join(resourcesDir, 'orcad-template')
  const manifest = requireRecord(readManifest(templateDir), 'manifest')
  if (manifest.schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    throw new Error(
      `[verify-packaged-orcad-template] manifest schemaVersion must be ${TEMPLATE_SCHEMA_VERSION}`
    )
  }
  const commonSha256 = requireRecord(manifest.commonSha256, 'commonSha256')
  const commonFilenames = orcadTemplateCommonFilenames()
  requireExactNames(Object.keys(commonSha256), commonFilenames, 'common manifest inventory')
  for (const filename of commonFilenames) {
    verifyFile(
      join(templateDir, ...filename.split('/')),
      requireSha256(commonSha256[filename], `${filename} checksum`),
      filename
    )
  }

  const manifestTargets = requireRecord(manifest.targets, 'targets')
  // Compat targets (design D6 rung B) are optional: a build without the compat slot omits them.
  const compatTargets = COMPAT_SERVER_TARGETS.filter((target) =>
    Object.hasOwn(manifestTargets, target)
  )
  const expectedTargets = [...targets, ...compatTargets]
  requireExactNames(Object.keys(manifestTargets), expectedTargets, 'target manifest inventory')
  requireExactNames(
    readdirSync(join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR)),
    expectedTargets,
    'target directory inventory'
  )
  for (const target of expectedTargets) {
    verifyTarget(templateDir, target, manifestTargets[target])
  }
  console.log(
    `[verify-packaged-orcad-template] OK — verified ${expectedTargets.length} Node targets`
  )
}

module.exports = { TEMPLATE_SCHEMA_VERSION, verifyPackagedOrcadTemplate }
