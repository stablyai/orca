#!/usr/bin/env node
// Packs one target's qualified template slot, its pinned Node and a launcher into the server-only
// tarball `orca serve` runs from on hosts without the desktop app.
//   node pack-orcad-server-artifact.mjs --template out/orcad-template --target linux-x64-glibc [--out-dir out/orca-server]
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { c as createTar } from 'tar'
import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_RUNTIMES_DIRNAME,
  ORCAD_SERVER_ENTRY_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  ORCAD_VERSION_FILENAME,
  ORCAD_CLI_ENTRY_FILENAME,
  orcadNodeRuntimeExecutable,
  orcadTemplateCommonFilenames,
  orcadTemplateTargetFilenames
} from '../../../../src/shared/orcad-artifacts.ts'
import { ORCAD_LOCAL_SERVE_SELECTION_ENTRY } from '../../../../src/shared/orcad-local-serve-selection.ts'
import {
  NODE_RUNTIME_PIN,
  nodeRuntimeExecutablePath,
  nodeRuntimeReleaseUrl,
  pinnedNodeRuntimeAsset
} from '../../../../src/shared/node-runtime-pin.ts'
import {
  ensurePinnedNodeExecutable,
  fetchPinnedFile,
  pinnedNodeCacheDir
} from '../prebuilds/pinned-node-downloads.mjs'
import { extract } from '../../node-runtime/archive-identity/update-node-runtime-pin.mjs'
import { computeOrcadFullVersion } from '../server-bundle/orcad-artifact-version.mjs'
import { assertNotDarkBuild } from '../../../dark-build-switches.cjs'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const SLOT_DIR = 'orcad'
const LAUNCHER = 'bin/orca-ide'

/** Published name without the libc suffix: only glibc slots are published. */
export function orcaServerArtifactName(target) {
  const match = /^(linux|darwin)-(x64|arm64)(?:-glibc)?$/.exec(target)
  if (!match) {
    throw new Error(
      `No server-only artifact for ${target}; use linux-x64-glibc or linux-arm64-glibc`
    )
  }
  return `orca-server-${match[1]}-${match[2]}`
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function isExecutable(filename) {
  return /(?:^|\/)(?:rg|spawn-helper)$/.test(filename)
}

function copyVerified(source, destination, expectedSha256, executable) {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  const actual = sha256(destination)
  if (actual !== expectedSha256) {
    throw new Error(`${source} hashed ${actual}; the template manifest expects ${expectedSha256}`)
  }
  if (executable) {
    chmodSync(destination, 0o755)
  }
}

/** Copies exactly the slot files the desktop deploys over SSH, each checked against the manifest. */
function stageSlot(templateDir, target, slotDir) {
  const manifest = JSON.parse(
    readFileSync(join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME), 'utf8')
  )
  const targetManifest = manifest.targets?.[target]
  if (!targetManifest) {
    throw new Error(`${templateDir} has no ${target} slot`)
  }
  const mobileWebAssets = Object.keys(manifest.commonSha256).filter((name) =>
    name.startsWith('out/mobile-web/')
  )
  const common = orcadTemplateCommonFilenames([])
  const commonFiles = [...new Set([...common, ...mobileWebAssets])]
  for (const filename of commonFiles) {
    const expected = manifest.commonSha256[filename]
    if (!expected) {
      throw new Error(`Template manifest omits ${filename}`)
    }
    copyVerified(
      join(templateDir, ...filename.split('/')),
      join(slotDir, ...filename.split('/')),
      expected,
      isExecutable(filename)
    )
  }
  for (const filename of orcadTemplateTargetFilenames(target)) {
    const expected = targetManifest.files?.[filename]
    if (!expected) {
      throw new Error(`Template manifest omits ${target} ${filename}`)
    }
    copyVerified(
      join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target, ...filename.split('/')),
      join(slotDir, ...filename.split('/')),
      expected,
      isExecutable(filename)
    )
  }
  // Hashed like a desktop slot without the optional browser, which this tarball omits.
  const version = computeOrcadFullVersion(slotDir, { target, agentBrowserFilename: null })
  writeFileSync(join(slotDir, ORCAD_VERSION_FILENAME), `${version}\n`)
  return version
}

// Why sh: it must run before any Node exists on the host. ELECTRON_RUN_AS_NODE=1 is how the packaged
// app's CLI runs, and the CLI strips it from the server's environment; the other two would point
// `serve` at a desktop app this install does not have.
function launcherScript(nodeRelativePath) {
  return `#!/bin/sh
# Orca server-only launcher: runs the bundled Orca CLI under the bundled Node.
set -e
self=$0
if command -v readlink >/dev/null 2>&1 && resolved=$(readlink -f -- "$self" 2>/dev/null); then
  self=$resolved
fi
root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)
node="$root/${nodeRelativePath}"
unset ORCA_APP_EXECUTABLE ORCA_SERVE_RUNTIME
ELECTRON_RUN_AS_NODE=1
export ELECTRON_RUN_AS_NODE
exec "$node" "$root/${SLOT_DIR}/${ORCAD_CLI_ENTRY_FILENAME}" "$@"
`
}

// The CLI asks `<app root>/out/main/<entry>.js` which server to run; here the answer is fixed.
function selectionEntryScript() {
  return `'use strict'
// Answers \`orca serve\`'s runtime question for the server-only artifact (src/shared/orcad-local-serve-selection.ts).
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const flag = process.argv.indexOf('--app-root')
const root = flag === -1 ? join(__dirname, '..', '..', '..') : process.argv[flag + 1]
const slot = join(root, ${JSON.stringify(SLOT_DIR)})
let selection
try {
  const version = readFileSync(join(slot, ${JSON.stringify(ORCAD_VERSION_FILENAME)}), 'utf8').trim()
  selection = { kind: 'orcad', runtime: process.execPath, entry: join(slot, ${JSON.stringify(ORCAD_SERVER_ENTRY_FILENAME)}), version }
} catch (error) {
  process.stderr.write('This Orca server install is incomplete; extract the release archive again.\\n')
  process.exit(1)
}
process.stdout.write('ORCA_SERVE_RUNTIME ' + JSON.stringify(selection) + '\\n')
`
}

/** Node's notice ships with its binary; it comes from the same hash-checked archive. */
async function copyNodeLicense(target, destination) {
  const asset = pinnedNodeRuntimeAsset(target)
  const cacheDir = pinnedNodeCacheDir()
  const archive = await fetchPinnedFile({
    url: nodeRuntimeReleaseUrl(asset.source, asset.archive),
    destination: join(cacheDir, asset.archive),
    sha256: asset.archiveSha256
  })
  const topLevel = nodeRuntimeExecutablePath(target, asset.archive).replace(/\/bin\/node$/, '')
  const extractDir = join(cacheDir, `license-${asset.archiveSha256.slice(0, 12)}`)
  extract(archive, extractDir, `${topLevel}/LICENSE`)
  copyFileSync(join(extractDir, topLevel, 'LICENSE'), destination)
}

function listEntries(dir, base = dir) {
  const entries = []
  for (const name of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  )) {
    const path = join(dir, name.name)
    entries.push(relative(base, path))
    if (name.isDirectory()) {
      entries.push(...listEntries(path, base))
    }
  }
  return entries
}

export async function packOrcaServerArtifact({ templateDir, target, outDir }) {
  // A dark build's template must never ship as a server either.
  assertNotDarkBuild([templateDir])
  const name = orcaServerArtifactName(target)
  const { version: appVersion } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const topDir = `orca-server-${appVersion}-${name.slice('orca-server-'.length)}`
  const stagingRoot = join(outDir, '.staging')
  const staging = join(stagingRoot, topDir)
  rmSync(stagingRoot, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  const orcadVersion = stageSlot(templateDir, target, join(staging, SLOT_DIR))
  const runtimeAsset = pinnedNodeRuntimeAsset(target)
  const nodeRelativePath = [
    ORCAD_RUNTIMES_DIRNAME,
    `${ORCAD_NODE_RUNTIME_DIR_PREFIX}${runtimeAsset.executableSha256}`,
    orcadNodeRuntimeExecutable(target)
  ].join('/')
  copyVerified(
    await ensurePinnedNodeExecutable({ target }),
    join(staging, ...nodeRelativePath.split('/')),
    runtimeAsset.executableSha256,
    true
  )
  const launcher = join(staging, ...LAUNCHER.split('/'))
  mkdirSync(dirname(launcher), { recursive: true })
  writeFileSync(launcher, launcherScript(nodeRelativePath), { mode: 0o755 })
  chmodSync(launcher, 0o755)
  const selectionEntry = join(staging, 'out', 'main', `${ORCAD_LOCAL_SERVE_SELECTION_ENTRY}.js`)
  mkdirSync(dirname(selectionEntry), { recursive: true })
  writeFileSync(selectionEntry, selectionEntryScript())
  writeFileSync(
    join(staging, 'VERSION'),
    `orca ${appVersion}\norcad ${orcadVersion}\nnode ${NODE_RUNTIME_PIN.version}\ntarget ${target}\n`
  )
  copyFileSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))
  await copyNodeLicense(target, join(staging, ORCAD_RUNTIMES_DIRNAME, 'NODE-LICENSE'))

  const archive = join(outDir, `${name}.tar.gz`)
  rmSync(archive, { force: true })
  createTar(
    {
      file: archive,
      sync: true,
      cwd: stagingRoot,
      gzip: { level: 9 },
      portable: true,
      noDirRecurse: true,
      // Fixed mtime: rebuilding the same tag yields the same bytes.
      mtime: new Date(Number(process.env.SOURCE_DATE_EPOCH ?? 0) * 1000)
    },
    [topDir, ...listEntries(staging).map((entry) => `${topDir}/${entry}`)]
  )
  rmSync(stagingRoot, { recursive: true, force: true })
  const digest = sha256(archive)
  writeFileSync(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`)
  return { archive, sha256: digest, topDir, orcadVersion }
}

function argument(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? null : (argv[index + 1] ?? null)
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const templateDir = argument(process.argv, '--template')
  const target = argument(process.argv, '--target')
  if (!templateDir || !target) {
    throw new Error(
      'Usage: pack-orcad-server-artifact.mjs --template <dir> --target <target> [--out-dir <dir>]'
    )
  }
  const result = await packOrcaServerArtifact({
    templateDir: resolve(templateDir),
    target,
    outDir: resolve(argument(process.argv, '--out-dir') ?? join(root, 'out', 'orca-server'))
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
