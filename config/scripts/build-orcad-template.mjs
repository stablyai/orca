#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
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
  ORCAD_EMOJI_SHORTCODE_DATASET,
  ORCAD_PARCEL_WATCHER_ENTRY,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR
} from '../../src/shared/orcad-artifacts.ts'
import { orcadAgentBrowserNativeName } from '../../src/shared/orcad-agent-browser-name.ts'
import { ORCAD_BUN_TARGETS } from '../../src/shared/orcad-bun-runtime.ts'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const outputDir = join(root, 'out', 'orcad-template')
const buildDir = join(root, 'out', '.orcad-template-build')
const commonArtifacts = [
  'orcad.js',
  'daemon-entry.js',
  'windows-bun-pty-gate-entry.js',
  'parcel-watcher-process-entry.js',
  ORCAD_PARCEL_WATCHER_ENTRY,
  ORCAD_EMOJI_SHORTCODE_DATASET
]

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

function stageTarget(target, requireFromWatcher) {
  const destination = join(outputDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
  const targetIdentity = join(destination, ORCAD_BUILD_TARGET_FILENAME)
  mkdirSync(destination, { recursive: true })
  writeFileSync(targetIdentity, `${target}\n`)
  const watcherSource = requireFromWatcher.resolve(`@parcel/watcher-${target}/watcher.node`)
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

function main() {
  buildCommonArtifacts()
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  for (const filename of commonArtifacts) {
    copy(join(buildDir, filename), join(outputDir, filename))
  }
  const requireFromWatcher = createRequire(
    join(root, 'node_modules', '@parcel', 'watcher', 'index.js')
  )
  const targets = Object.fromEntries(
    ORCAD_BUN_TARGETS.map((target) => [target, stageTarget(target, requireFromWatcher)])
  )
  const commonSha256 = Object.fromEntries(
    commonArtifacts.map((filename) => [filename, sha256(join(outputDir, filename))])
  )
  writeFileSync(
    join(outputDir, ORCAD_TEMPLATE_MANIFEST_FILENAME),
    `${JSON.stringify({ schemaVersion: 2, commonSha256, targets }, null, 2)}\n`
  )
  rmSync(buildDir, { recursive: true, force: true })
  process.stdout.write(`[build-orcad-template] ok — ${ORCAD_BUN_TARGETS.length} targets\n`)
}

main()
