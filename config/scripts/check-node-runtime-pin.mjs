#!/usr/bin/env node
// Static, offline consistency gate for src/shared/node-runtime-pin.ts; update-node-runtime-pin.mjs owns the network.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseAllDocuments } from 'yaml'
import { nodeDistArchiveName, windowsImportLibFile } from './node-dist-archive-name.mjs'

// Why require: an ESM import of a .ts file under a typeless package.json prints MODULE_TYPELESS_PACKAGE_JSON.
const {
  COMPAT_SERVER_TARGETS,
  NODE_RUNTIME_ASSETS,
  NODE_RUNTIME_COMPAT_ASSETS,
  NODE_RUNTIME_PIN,
  SERVER_TARGETS
} = createRequire(import.meta.url)('../../src/shared/node-runtime-pin.ts')

const SHA256 = /^[0-9a-f]{64}$/
const ASSET_SOURCES = new Set(['official', 'unofficial'])

function majorOf(range) {
  const match = /(\d+)/.exec(String(range ?? ''))
  return match ? Number(match[1]) : null
}

/** Strips pnpm's peer suffix: `43.7.5(supports-color@7.2.0)` -> `43.7.5`. */
function lockedVersion(entry) {
  const version = typeof entry === 'string' ? entry : entry?.version
  return typeof version === 'string' ? version.replace(/\(.*$/, '') : null
}

/** pnpm 12 splits the lockfile into a package-manager document and the project one; merge both. */
export function lockfileRootImporter(contents) {
  const importer = {}
  for (const document of parseAllDocuments(contents)) {
    if (document.errors.length) {
      throw document.errors[0]
    }
    Object.assign(importer, document.toJS()?.importers?.['.'])
  }
  return importer
}

function findAssetTableProblems({ pin, assets, targets, table, targetList }) {
  const problems = []
  const expected = new Set(targets)
  for (const target of targets) {
    if (!Object.hasOwn(assets, target)) {
      problems.push(`${table} has no entry for ${target}`)
    }
  }
  for (const [target, asset] of Object.entries(assets)) {
    if (!expected.has(target)) {
      problems.push(`${table} has ${target}, which is not in ${targetList}`)
      continue
    }
    if (!ASSET_SOURCES.has(asset.source)) {
      problems.push(`${target}: source must be official or unofficial, got ${asset.source}`)
    }
    const expectedArchive = nodeDistArchiveName(pin.version, target)
    if (asset.archive !== expectedArchive) {
      problems.push(`${target}: archive ${asset.archive} is not ${expectedArchive}`)
    }
    if (!SHA256.test(asset.archiveSha256 ?? '')) {
      problems.push(`${target}: archiveSha256 is not a 64-character hex SHA-256`)
    }
    if (!SHA256.test(asset.executableSha256 ?? '')) {
      problems.push(`${target}: executableSha256 is not a 64-character hex SHA-256`)
    }
    if (!Number.isInteger(asset.executableSize) || asset.executableSize <= 0) {
      problems.push(`${target}: executableSize must be a positive integer`)
    }
  }
  return problems
}

export function findNodeRuntimePinProblems({
  pin,
  assets,
  targets,
  compatAssets = {},
  compatTargets = [],
  packageJson,
  rootImporter
}) {
  const problems = []
  const declaredElectron =
    packageJson.devDependencies?.electron ?? packageJson.dependencies?.electron
  if (declaredElectron !== pin.electron) {
    problems.push(
      `package.json electron is ${declaredElectron}, but NODE_RUNTIME_PIN.electron is ${pin.electron}`
    )
  }
  const lockedElectron = lockedVersion(
    rootImporter.devDependencies?.electron ?? rootImporter.dependencies?.electron
  )
  if (lockedElectron !== pin.electron) {
    problems.push(
      `pnpm-lock.yaml resolves electron ${lockedElectron}, but NODE_RUNTIME_PIN.electron is ${pin.electron}`
    )
  }
  // Only the major is gated here; whether the pin may differ from Electron's Node is design D1
  // (docs/reference/node-runtime-design.html).
  const engineMajor = majorOf(packageJson.engines?.node)
  if (majorOf(pin.version) !== engineMajor) {
    problems.push(
      `NODE_RUNTIME_PIN.version ${pin.version} is not package.json engines.node major ${engineMajor}`
    )
  }
  if (!Number.isInteger(pin.napi) || pin.napi < 1) {
    problems.push(`NODE_RUNTIME_PIN.napi must be a positive integer, got ${pin.napi}`)
  }
  if (!SHA256.test(pin.headers?.sha256 ?? '')) {
    problems.push('NODE_RUNTIME_PIN.headers.sha256 is not a 64-character hex SHA-256')
  }
  if (pin.headers?.file !== `node-v${pin.version}-headers.tar.gz`) {
    problems.push(`NODE_RUNTIME_PIN.headers.file ${pin.headers?.file} is not for ${pin.version}`)
  }
  for (const target of targets.filter((name) => name.startsWith('win32-'))) {
    const lib = pin.windowsImportLibs?.[target]
    if (lib?.file !== windowsImportLibFile(target)) {
      problems.push(
        `NODE_RUNTIME_PIN.windowsImportLibs.${target}.file is not ${windowsImportLibFile(target)}`
      )
    }
    if (!SHA256.test(lib?.sha256 ?? '')) {
      problems.push(
        `NODE_RUNTIME_PIN.windowsImportLibs.${target}.sha256 is not a 64-character hex SHA-256`
      )
    }
  }

  problems.push(
    ...findAssetTableProblems({
      pin,
      assets,
      targets,
      table: 'NODE_RUNTIME_ASSETS',
      targetList: 'SERVER_TARGETS'
    }),
    ...findAssetTableProblems({
      pin,
      assets: compatAssets,
      targets: compatTargets,
      table: 'NODE_RUNTIME_COMPAT_ASSETS',
      targetList: 'COMPAT_SERVER_TARGETS'
    })
  )
  return problems
}

export function main(root = resolve(import.meta.dirname, '../..')) {
  const problems = findNodeRuntimePinProblems({
    pin: NODE_RUNTIME_PIN,
    assets: NODE_RUNTIME_ASSETS,
    targets: SERVER_TARGETS,
    compatAssets: NODE_RUNTIME_COMPAT_ASSETS,
    compatTargets: COMPAT_SERVER_TARGETS,
    packageJson: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    rootImporter: lockfileRootImporter(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
  })
  if (problems.length > 0) {
    console.error('Node runtime pin check failed:')
    for (const problem of problems) {
      console.error(`- ${problem}`)
    }
    console.error(
      'Regenerate with: node config/scripts/update-node-runtime-pin.mjs --version <x.y.z>'
    )
    return 1
  }
  console.log(
    `Node runtime pin check passed: Node ${NODE_RUNTIME_PIN.version} for Electron ${NODE_RUNTIME_PIN.electron}.`
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
