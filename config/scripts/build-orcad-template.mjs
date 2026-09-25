#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  orcadTemplateCommonFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { orcadAgentBrowserNativeName } from '../../src/shared/orcad-agent-browser-name.ts'
import { ORCAD_TEMPLATE_TARGETS } from '../../src/shared/orcad-bun-runtime.ts'
import { runProcessSync } from './script-child-process.mjs'
import { materializeWatcherPackage } from './orcad-watcher-package.mjs'
import { verifyPackagedOrcadTemplate } from './verify-packaged-orcad-template.cjs'

const root = resolve(import.meta.dirname, '../..')
const outputDir = join(root, 'out', 'orcad-template')
const buildDir = join(root, 'out', '.orcad-template-build')
const commonArtifacts = orcadTemplateCommonFilenames()

function copy(source, destination, executable = false) {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  if (executable && process.platform !== 'win32') {
    chmodSync(destination, 0o755)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function targetPlatform(target) {
  return target.split('-')[0]
}

function targetArch(target) {
  return target.split('-')[1]
}

function buildCommonArtifacts() {
  rmSync(buildDir, { recursive: true, force: true })
  const result = runProcessSync({
    program: process.execPath,
    args: [join(root, 'config/scripts/build-orcad-bun.mjs'), '--out-dir', buildDir],
    cwd: root,
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    throw new Error(`Common orcad artifact build failed with exit ${result.code ?? 'unknown'}`)
  }
}

async function stageTarget(target) {
  const destination = join(outputDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetIdentity = join(destination, ORCAD_BUILD_TARGET_FILENAME)
  mkdirSync(destination, { recursive: true })
  writeFileSync(targetIdentity, `${target}\n`)
  const watcherSource = await materializeWatcherPackage(target)
  const watcherDestination = join(destination, 'watcher.node')
  copy(watcherSource, watcherDestination)

  const browserName = orcadAgentBrowserNativeName(
    targetPlatform(target),
    targetArch(target),
    target.endsWith('-musl') ? 'musl' : 'glibc'
  )
  const browserSource = join(root, 'node_modules', 'agent-browser', 'bin', browserName)
  const browserDestination = join(destination, browserName)
  if (existsSync(browserSource)) {
    copy(browserSource, browserDestination, true)
  }
  return {
    targetSha256: sha256(targetIdentity),
    watcherSha256: sha256(watcherDestination),
    ...(existsSync(browserDestination)
      ? { browserName, browserSha256: sha256(browserDestination) }
      : {})
  }
}

async function main() {
  buildCommonArtifacts()
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  for (const filename of commonArtifacts) {
    copy(join(buildDir, filename), join(outputDir, filename))
  }
  const targets = Object.fromEntries(
    await Promise.all(
      ORCAD_TEMPLATE_TARGETS.map(async (target) => [target, await stageTarget(target)])
    )
  )
  const commonSha256 = Object.fromEntries(
    commonArtifacts.map((filename) => [filename, sha256(join(outputDir, filename))])
  )
  writeFileSync(
    join(outputDir, ORCAD_TEMPLATE_MANIFEST_FILENAME),
    `${JSON.stringify({ schemaVersion: 2, commonSha256, targets }, null, 2)}\n`
  )
  verifyPackagedOrcadTemplate(join(root, 'out'))
  rmSync(buildDir, { recursive: true, force: true })
  process.stdout.write(`[build-orcad-template] ok — ${ORCAD_TEMPLATE_TARGETS.length} targets\n`)
}

await main()
