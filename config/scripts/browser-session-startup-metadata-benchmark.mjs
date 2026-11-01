import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = resolve(import.meta.dirname, '../..')
const baseline = process.argv[2] ?? 'HEAD^'
const require = createRequire(join(root, 'package.json'))
const { build } = require('esbuild')
const relative = 'src/main/browser/browser-session-registry.ts'
const target = join(root, relative)
const scratch = mkdtempSync(join(tmpdir(), 'orca-browser-meta-bench-'))
const previousSource = execFileSync('git', ['show', `${baseline}:${relative}`], {
  cwd: root,
  encoding: 'utf8'
})
const sources = { before: previousSource, after: readFileSync(target, 'utf8') }
const stubs = new Map([
  [
    'electron',
    'export const app={getPath:()=>globalThis.__metaBench.directory}; export const session={fromPartition:()=>({})};'
  ],
  [
    './browser-session-cookie-staging',
    'export function applyPendingBrowserCookieImports(){} export function clearPendingBrowserCookieImport(){}'
  ],
  [
    './browser-session-partition-policies',
    'export async function installBrowserSessionPartitionPolicies(){}'
  ],
  [
    './browser-session-route-policies',
    'export function clearBrowserRoutePartitionPolicies(){} export async function installBrowserRoutePartitionPolicies(){}'
  ],
  [
    './browser-session-profile-retirement',
    'export async function retireDeletedBrowserSessionProfile(){} export async function retireFailedBrowserSessionProfile(){}'
  ],
  [
    '../persistence/loading-store/user-data-path',
    'export function getCanonicalUserDataPath(){return globalThis.__metaBench.directory}'
  ],
  [
    './browser-identity-mode-store',
    'export async function markBrowserIdentityMigrationNoticePending(){}'
  ],
  ['./browser-site-permission-store', 'export function forgetBrowserSitePermissions(){}'],
  ['./browser-site-display-store', 'export function forgetBrowserSiteDisplay(){}'],
  [
    './extensions/browser-extension-session-loader',
    'export function attachBrowserExtensionsToProfileSession(profile,ids){globalThis.__metaBench.assignments.push([profile.id,ids])}'
  ]
])
const registryByVersion = {}
try {
  for (const [version, source] of Object.entries(sources)) {
    const output = join(scratch, `${version}.cjs`)
    await build({
      stdin: { contents: source, sourcefile: target, resolveDir: dirname(target), loader: 'ts' },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: output,
      plugins: [
        {
          name: 'isolate-startup-metadata',
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (args.importer === target && stubs.has(args.path)) {
                return { path: args.path, namespace: 'startup-stub' }
              }
              if (
                args.path === 'node:fs' &&
                args.importer.endsWith('/browser-session-meta-store.ts')
              ) {
                return { path: 'fs-probe', namespace: 'startup-stub' }
              }
            })
            builder.onLoad({ filter: /.*/, namespace: 'startup-stub' }, (args) => ({
              contents:
                args.path === 'fs-probe'
                  ? `import * as fs from 'node:fs'; export const {mkdirSync,renameSync,writeFileSync}=fs; export function readFileSync(...args){const result=fs.readFileSync(...args);globalThis.__metaBench.reads++;globalThis.__metaBench.bytes+=Buffer.byteLength(result);return result}`
                  : stubs.get(args.path),
              loader: 'js'
            }))
          }
        }
      ]
    })
    globalThis.__metaBench = { directory: scratch, reads: 0, bytes: 0, assignments: [] }
    registryByVersion[version] = require(output).browserSessionRegistry
  }
  const rows = []
  for (const count of [10, 100, 1000]) {
    const profiles = Array.from({ length: count }, (_, index) => {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
      return {
        id,
        scope: 'isolated',
        partition: `persist:orca-browser-session-${id}`,
        label: `Browser ${index}`,
        source: null
      }
    })
    const enabledExtensionIdsByProfileId = Object.fromEntries([
      ['default', ['default-extension']],
      ...profiles.map((profile, index) => [profile.id, [`extension-${index}`]])
    ])
    const json = JSON.stringify({ profiles, enabledExtensionIdsByProfileId })
    writeFileSync(join(scratch, 'browser-session-meta.json'), json)
    const row = { profiles: count, metadataBytes: Buffer.byteLength(json) }
    let beforeAssignments
    for (const [version, registry] of Object.entries(registryByVersion)) {
      const timings = []
      for (let iteration = 0; iteration < 4; iteration++) {
        globalThis.__metaBench = { directory: scratch, reads: 0, bytes: 0, assignments: [] }
        registry.configureForOrcaProfile({
          orcaProfileId: 'local-default',
          profileDirectory: scratch
        })
        globalThis.__metaBench.reads = 0
        globalThis.__metaBench.bytes = 0
        const start = performance.now()
        registry.initializeBrowserSessionsFromPersistedState()
        const durationMs = performance.now() - start
        const probe = globalThis.__metaBench
        assert.equal(probe.reads, version === 'before' ? count + 2 : 1)
        assert.equal(registry.listProfiles().length, count + 1)
        assert.equal(probe.assignments.length, count + 1)
        if (version === 'before') {
          beforeAssignments = probe.assignments
        } else {
          assert.deepEqual(probe.assignments, beforeAssignments)
        }
        if (iteration > 0) {
          timings.push(durationMs)
        }
        row[version] = { reads: probe.reads, bytes: probe.bytes }
        await Promise.resolve()
      }
      timings.sort((left, right) => left - right)
      row[version].medianSynchronousMs = Number(timings[1].toFixed(3))
    }
    rows.push(row)
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        baseline,
        productionSeam: 'initializeBrowserSessionsFromPersistedState',
        limitations:
          'Warm local filesystem; actual registry, JSON parser, profile validation and disk reads. Electron policy installation and extension loading stubbed. Synchronous hydration only; excludes process startup and guest creation.',
        rows
      },
      null,
      2
    )
  )
} finally {
  rmSync(scratch, { recursive: true, force: true })
  delete globalThis.__metaBench
}
