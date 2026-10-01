/**
 * The orcad deployment template inside desktop builds (design D2): JS plus every target's
 * addons, never a Node runtime. SSH relays and managed orcad deploys materialize a target's
 * slot from it (src/main/ssh/orcad-artifact-materializer.ts, `process.resourcesPath`).
 *
 *   node config/scripts/packaged-orcad-template.cjs --reseal-signed <appDir> <signedListFile>
 *
 * reseals after an out-of-band signer (SignPath) rewrote template binaries in `<appDir>`.
 */
const { createHash } = require('node:crypto')
const {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync
} = require('node:fs')
const { join, relative, resolve, sep } = require('node:path')
const {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR
} = require('../../src/shared/orcad-artifacts.ts')
const { verifyPackagedOrcadTemplate } = require('./verify-packaged-orcad-template.cjs')

const ORCAD_TEMPLATE_RESOURCE_DIR = 'orcad-template'
const orcadTemplateExtraResource = { from: 'out/orcad-template', to: ORCAD_TEMPLATE_RESOURCE_DIR }
// Why a second entry: electron-builder's copy filter always drops a source's root node_modules.
const orcadTemplateNodeModulesExtraResource = {
  from: `${orcadTemplateExtraResource.from}/node_modules`,
  to: `${ORCAD_TEMPLATE_RESOURCE_DIR}/node_modules`
}
// Why the whole tree: codesign rejects its ELF/PE payloads, and the darwin ones are signed in
// afterPack so their new hashes can be resealed into the manifest before the app is sealed.
const orcadTemplateMacSignIgnore = ['/orcad-template/']

// Mach-O thin (both byte orders, 32/64-bit) and fat headers.
const MACH_O_MAGICS = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'])

/** Release packaging sets it; dev and local builds may ship without the template. */
function isOrcadTemplateRequired(env = process.env) {
  return env.ORCA_REQUIRE_ORCAD_TEMPLATE === '1'
}

// Why: electron-builder only warns on a missing extraResources source.
function assertOrcadTemplateBuilt(projectDir = join(__dirname, '..', '..'), env = process.env) {
  const manifest = join(
    projectDir,
    orcadTemplateExtraResource.from,
    ORCAD_TEMPLATE_MANIFEST_FILENAME
  )
  if (isOrcadTemplateRequired(env) && !existsSync(manifest)) {
    throw new Error(
      `ORCA_REQUIRE_ORCAD_TEMPLATE=1 but ${manifest} is missing; download the merged template ` +
        'from the release template job, or build it with `pnpm build:orcad-template`.'
    )
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function isMachO(path) {
  const fd = openSync(path, 'r')
  try {
    const header = Buffer.alloc(4)
    return readSync(fd, header, 0, 4, 0) === 4 && MACH_O_MAGICS.has(header.toString('hex'))
  } finally {
    closeSync(fd)
  }
}

/** Template-relative paths of the darwin targets' Mach-O files, which macOS signing rewrites. */
function findOrcadTemplateMachOFiles(templateDir) {
  const targetsDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR)
  return readdirSync(targetsDir)
    .filter((target) => target.startsWith('darwin-'))
    .flatMap((target) =>
      readdirSync(join(targetsDir, target), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && isMachO(join(entry.parentPath, entry.name)))
        .map((entry) =>
          relative(templateDir, join(entry.parentPath, entry.name)).split(sep).join('/')
        )
    )
    .sort()
}

/**
 * Re-records the hashes of files a platform signer rewrote. Only the named files move; every
 * other file must still match what the template build recorded, which the verify after this
 * enforces, so a reseal cannot launder an unrelated change.
 */
function resealOrcadTemplateManifest(templateDir, signedPaths) {
  const manifestPath = join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const path of signedPaths) {
    const segments = path.split('/')
    const target =
      segments[0] === ORCAD_TEMPLATE_TARGETS_DIR ? manifest.targets?.[segments[1]] : undefined
    const filename = segments.slice(2).join('/')
    const digest = () => sha256(join(templateDir, ...segments))
    if (target?.files && Object.hasOwn(target.files, filename)) {
      target.files[filename] = digest()
    } else if (target && target.browserName === filename) {
      target.browserSha256 = digest()
    } else if (!target && Object.hasOwn(manifest.commonSha256 ?? {}, path)) {
      manifest.commonSha256[path] = digest()
    } else {
      throw new Error(`[packaged-orcad-template] ${path} is not a template manifest entry`)
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/**
 * afterPack: sign the darwin payloads on macOS (notarization requires every nested Mach-O to
 * carry the app's Developer ID), reseal, then verify the exact bytes that ship.
 */
async function finalizePackagedOrcadTemplate(resourcesDir, options) {
  const { platform, env = process.env, signMacBinary } = options
  const templateDir = join(resourcesDir, ORCAD_TEMPLATE_RESOURCE_DIR)
  if (!existsSync(templateDir)) {
    if (isOrcadTemplateRequired(env)) {
      throw new Error(`Packaged app is missing the orcad deployment template: ${templateDir}`)
    }
    // SSH relays then keep the legacy host-Node path (ssh-relay-pinned-node.ts).
    console.log('[packaged-orcad-template] skipped: this build ships no orcad template')
    return
  }
  if (platform === 'darwin') {
    const machO = findOrcadTemplateMachOFiles(templateDir)
    for (const path of machO) {
      await signMacBinary(join(templateDir, ...path.split('/')))
    }
    resealOrcadTemplateManifest(templateDir, machO)
  }
  verifyPackagedOrcadTemplate(resourcesDir)
}

/** `inner-signing-list.txt` lines are app-relative Windows paths; keep the template's. */
function resealSignedWindowsApp(appDir, signedListFile) {
  const prefix = `resources/${ORCAD_TEMPLATE_RESOURCE_DIR}/`
  const signed = readFileSync(signedListFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll('\\', '/'))
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
  const resourcesDir = join(appDir, 'resources')
  if (!existsSync(join(resourcesDir, ORCAD_TEMPLATE_RESOURCE_DIR))) {
    if (isOrcadTemplateRequired()) {
      throw new Error(`Signed app is missing the orcad deployment template under ${resourcesDir}`)
    }
    console.log('[packaged-orcad-template] skipped reseal: this build ships no orcad template')
    return
  }
  resealOrcadTemplateManifest(join(resourcesDir, ORCAD_TEMPLATE_RESOURCE_DIR), signed)
  verifyPackagedOrcadTemplate(resourcesDir)
  console.log(`[packaged-orcad-template] resealed ${signed.length} signed template file(s)`)
}

module.exports = {
  ORCAD_TEMPLATE_RESOURCE_DIR,
  assertOrcadTemplateBuilt,
  finalizePackagedOrcadTemplate,
  findOrcadTemplateMachOFiles,
  isOrcadTemplateRequired,
  orcadTemplateExtraResource,
  orcadTemplateNodeModulesExtraResource,
  orcadTemplateMacSignIgnore,
  resealOrcadTemplateManifest,
  resealSignedWindowsApp
}

if (require.main === module) {
  const [flag, appDir, signedListFile] = process.argv.slice(2)
  if (flag !== '--reseal-signed' || !appDir || !signedListFile) {
    console.error('usage: packaged-orcad-template.cjs --reseal-signed <appDir> <signedListFile>')
    process.exit(2)
  }
  resealSignedWindowsApp(resolve(appDir), resolve(signedListFile))
}
