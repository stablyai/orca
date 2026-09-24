const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { verifyPackagedOrcadTemplate } = require('./verify-packaged-orcad-template.cjs')
const {
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR
} = require('../../src/shared/orcad-artifacts.ts')

async function defaultSign(options) {
  return require('app-builder-lib/out/codeSign/macCodeSign').sign(options)
}

/** Capture signed native bytes before the outer app seals the deployment manifest. */
async function signMacAppWithOrcadTemplate(options, sign = defaultSign) {
  const resourcesDir = join(options.app, 'Contents', 'Resources')
  const templateDir = join(resourcesDir, 'orcad-template')
  const manifestPath = join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
  verifyPackagedOrcadTemplate(resourcesDir)
  let expectedManifest = readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(expectedManifest)
  const nativeFiles = new Map()
  for (const [target, entry] of Object.entries(manifest.targets)) {
    if (!target.startsWith('darwin-')) {
      continue
    }
    const directory = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
    nativeFiles.set(resolve(directory, 'watcher.node'), { entry, field: 'watcherSha256' })
    if (entry.browserName) {
      nativeFiles.set(resolve(directory, entry.browserName), { entry, field: 'browserSha256' })
    }
  }
  const signedFiles = new Set()
  let finalized = false
  await sign({
    ...options,
    optionsForFile(filePath) {
      const path = resolve(filePath)
      if (nativeFiles.has(path)) {
        signedFiles.add(path)
      }
      if (path === resolve(options.app)) {
        if (signedFiles.size !== nativeFiles.size) {
          throw new Error('The macOS signer skipped an Orca runtime native payload')
        }
        if (readFileSync(manifestPath, 'utf8') !== expectedManifest) {
          throw new Error('The Orca runtime manifest changed during signing')
        }
        for (const [file, { entry, field }] of nativeFiles) {
          entry[field] = createHash('sha256').update(readFileSync(file)).digest('hex')
        }
        expectedManifest = `${JSON.stringify(manifest, null, 2)}\n`
        writeFileSync(manifestPath, expectedManifest)
        verifyPackagedOrcadTemplate(resourcesDir)
        finalized = true
      }
      return options.optionsForFile?.(filePath)
    }
  })
  if (!finalized) {
    throw new Error('The macOS signer did not finalize the Orca runtime manifest')
  }
  verifyPackagedOrcadTemplate(resourcesDir)
}

module.exports = { signMacAppWithOrcadTemplate }
