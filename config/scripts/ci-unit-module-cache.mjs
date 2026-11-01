import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  globSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { collectNodeServerInputs } from './node-server-change-scope.mjs'
import { workspacePackageManifests } from './workspace-source-exports.mjs'
import { writeAssignment } from './ci-shard-assignment.mjs'
import { sealModuleCache, validateModuleCache } from './ci-unit-module-cache-contents.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const IDENTITY_REPORT = 'ci-shards/unit-module-cache-identity.json'
const CACHE_REPORT = 'ci-shards/unit-module-cache.json'
const CACHE_FORMAT = '1.0.0-beta.8'

function digestInputs(root, files) {
  const hash = createHash('sha256')
  for (const file of [...new Set(files)].sort()) {
    if (!existsSync(join(root, file))) {
      hash.update(`${file}\0missing\0`)
      continue
    }
    const bytes = readFileSync(join(root, file))
    hash.update(`${file}\0${bytes.length}\0`).update(bytes)
  }
  return hash.digest('hex')
}

export async function moduleCachePolicyHash(root = ROOT) {
  const runnerScripts = globSync('config/scripts/vitest*.{mjs,ts}', { cwd: root }).filter(
    (file) => !file.includes('.test.')
  )
  const configInputs = await collectNodeServerInputs({
    root,
    entryPoints: [
      'config/vitest.config.ts',
      'config/scripts/run-vitest.mjs',
      'config/scripts/ci-unit-timing-reporter.mjs',
      ...runnerScripts
    ]
  })
  return digestInputs(root, [
    ...configInputs,
    ...workspacePackageManifests(root),
    // tsconfig and package.json (type/imports) steer transforms but are not in Vitest's per-module key.
    ...globSync(['config/patches/**', '**/tsconfig*.json', '**/package.json'], {
      cwd: root,
      exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', 'mobile/vendor/**']
    }).filter((file) => statSync(join(root, file)).isFile()),
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    'config/pnpmfile.cjs',
    'config/.bun-version',
    'config/dark-build-switches.cjs',
    'config/scripts/ci-unit-module-cache.mjs',
    'config/scripts/ci-unit-module-cache-contents.mjs',
    'config/scripts/ci-unit-module-cache-trailer.mjs'
  ])
}

export function moduleCacheIdentity({
  root = ROOT,
  cacheRoot = process.env.RUNNER_TEMP,
  policyHash,
  installedLockHash,
  versions,
  shard,
  platform = process.platform,
  arch = process.arch,
  nodeEnv = process.env.NODE_ENV ?? 'test',
  namespace = ''
}) {
  if (
    !cacheRoot ||
    !/^[a-f0-9]{64}$/.test(policyHash ?? '') ||
    !/^[a-f0-9]{64}$/.test(installedLockHash ?? '') ||
    ![versions?.node, versions?.bun, versions?.vitest].every((version) =>
      /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version ?? '')
    ) ||
    !Number.isInteger(shard?.index) ||
    !Number.isInteger(shard?.count) ||
    shard.index < 1 ||
    shard.index > shard.count
  ) {
    throw new Error('Unit module cache identity is incomplete')
  }
  const identity = {
    format: CACHE_FORMAT,
    root: realpathSync(root),
    platform,
    arch,
    versions,
    policyHash,
    installedLockHash,
    nodeEnv,
    shard,
    namespace
  }
  const digest = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  return {
    ...identity,
    key: `unit-module-v2-${platform}-${arch}-n${versions.node}-b${versions.bun}-v${versions.vitest}-s${shard.index}of${shard.count}-${digest}`,
    path: join(resolve(cacheRoot), 'orca-vitest-module-cache')
  }
}

export async function resolveModuleCacheIdentity({
  root = ROOT,
  cacheRoot = process.env.RUNNER_TEMP,
  shard,
  namespace = ''
} = {}) {
  const require = createRequire(join(root, 'package.json'))
  const bun = runProcessSync({ program: 'bun', args: ['--version'], cwd: root, timeoutMs: 10_000 })
  if (bun.code !== 0) {
    throw new Error('Bun version is unavailable')
  }
  return moduleCacheIdentity({
    root,
    cacheRoot,
    shard,
    namespace,
    policyHash: await moduleCachePolicyHash(root),
    installedLockHash: createHash('sha256')
      .update(readFileSync(join(root, 'node_modules', '.pnpm', 'lock.yaml')))
      .digest('hex'),
    versions: {
      node: process.versions.node,
      bun: bun.stdout.trim(),
      vitest: require('vitest/package.json').version
    }
  })
}

export async function prepareModuleCache(identity, { restoreHit = false } = {}) {
  const started = performance.now()
  try {
    if (!restoreHit) {
      throw new Error('No exact cache was restored')
    }
    const manifest = await validateModuleCache({
      path: identity.path,
      key: identity.key,
      format: identity.format,
      versions: identity.versions,
      lockfileHash: identity.installedLockHash.slice(0, 8)
    })
    return {
      available: true,
      entries: manifest.entries.length,
      bytes: manifest.totalBytes,
      producerSourceSha: manifest.sourceSha,
      validationMs: performance.now() - started
    }
  } catch (error) {
    rmSync(identity.path, { recursive: true, force: true })
    return {
      available: false,
      reason: String(error),
      validationMs: performance.now() - started
    }
  }
}

export async function finishModuleCache(identity, { sourceSha } = {}) {
  const started = performance.now()
  const manifest = await sealModuleCache({
    ...identity,
    sourceSha,
    lockfileHash: identity.installedLockHash.slice(0, 8)
  })
  return {
    entries: manifest.entries.length,
    bytes: manifest.totalBytes,
    sealMs: performance.now() - started
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const phase = process.argv[2]
  const output = (values) => {
    if (process.env.GITHUB_OUTPUT) {
      for (const [key, value] of Object.entries(values)) {
        appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
      }
    }
  }
  if (phase === 'identity') {
    try {
      const identity = await resolveModuleCacheIdentity({
        shard: {
          index: Number(process.env.ORCA_UNIT_SHARD_INDEX),
          count: Number(process.env.ORCA_UNIT_SHARD_COUNT)
        },
        namespace: process.env.ORCA_UNIT_CACHE_NAMESPACE ?? ''
      })
      writeAssignment(IDENTITY_REPORT, identity)
      output({ key: identity.key, path: identity.path })
      if (process.env.GITHUB_ENV) {
        appendFileSync(process.env.GITHUB_ENV, `ORCA_UNIT_MODULE_CACHE_PATH=${identity.path}\n`)
      }
    } catch (error) {
      console.warn(`Unit module cache unavailable: ${String(error)}`)
    }
  } else {
    const identity = JSON.parse(readFileSync(IDENTITY_REPORT, 'utf8'))
    if (phase === 'prepare') {
      const result = await prepareModuleCache(identity, {
        restoreHit: process.env.ORCA_UNIT_CACHE_RESTORE_HIT === 'true'
      })
      writeAssignment(CACHE_REPORT, { key: identity.key, mode: 'restore', ...result })
      console.log(JSON.stringify(result))
    } else if (phase === 'seal') {
      try {
        const result = await finishModuleCache(identity, {
          sourceSha: process.env.ORCA_SHARD_SOURCE_SHA ?? process.env.GITHUB_SHA
        })
        const previous = JSON.parse(readFileSync(CACHE_REPORT, 'utf8'))
        writeAssignment(CACHE_REPORT, { ...previous, produced: result })
        output({ ready: true })
        console.log(JSON.stringify(result))
      } catch (error) {
        console.warn(`Unit module cache was not saved: ${String(error)}`)
      }
    } else {
      throw new Error(`Unknown unit module cache phase: ${phase}`)
    }
  }
}
