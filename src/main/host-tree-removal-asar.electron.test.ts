import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../shared/windows-transient-lock-removal'

/** Electron’s asar fs shim makes recursive removal fail; plain Node cannot reproduce it. */
const requireFromTest = createRequire(import.meta.url)
const electronBinary = requireFromTest('electron') as string
const electronDist = join(dirname(requireFromTest.resolve('electron/package.json')), 'dist')
const FIXTURE_ASAR = [
  join(electronDist, 'Electron.app/Contents/Resources/default_app.asar'),
  join(electronDist, 'resources/default_app.asar')
].find((candidate) => existsSync(candidate))

const ENTRY_NAME = 'wt-1700000000000-abcdef01'
const ASAR_PARENT = 'node_modules/.pnpm/electron/node_modules/electron/dist/App/Contents/Resources'

const roots: string[] = []

afterAll(() => {
  for (const root of roots) {
    try {
      removeTreeSync(root)
    } catch {
      // Failed cases can strand archives; cleanup must not obscure the assertion.
    }
  }
})

type ProbeResult = { failure: string | null; residue: string[] }

function buildDriver(bundlePath: string, target: string, resultPath: string): string {
  return [
    `const fs = require('node:fs')`,
    `const { removeHostTree } = require(${JSON.stringify(bundlePath)})`,
    // Inspect residue without the shim treating remaining archives as directories.
    `const withoutAsar = (fn) => { const prev = process.noAsar; process.noAsar = true; try { return fn() } finally { process.noAsar = prev } }`,
    `;(async () => {`,
    `  let failure = null`,
    `  try { await removeHostTree(${JSON.stringify(target)}) } catch (error) { failure = error.code ?? String(error) }`,
    `  const residue = withoutAsar(() => fs.existsSync(${JSON.stringify(target)})`,
    `    ? fs.readdirSync(${JSON.stringify(target)}, { recursive: true }).map(String)`,
    `    : [])`,
    `  fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ failure, residue }))`,
    `})()`
  ].join('\n')
}

async function bundleHostTreeRemoval(outFile: string): Promise<void> {
  const { build } = await import('vite')
  const result = await build({
    root: process.cwd(),
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      ssr: true,
      rollupOptions: {
        input: 'src/main/host-tree-removal.ts',
        // Match production externals: externalizing original-fs here could hide a bundling regression.
        output: { format: 'cjs' },
        external: (id: string) => isBuiltin(id) || id === 'electron' || id.startsWith('electron/')
      }
    }
  })
  const output = (Array.isArray(result) ? result[0] : result) as { output: { code?: string }[] }
  const code = output.output[0]?.code
  expect(typeof code).toBe('string')
  writeFileSync(outFile, code as string, 'utf8')
}

function buildStrandedTree(root: string): string {
  const target = join(root, ENTRY_NAME)
  const asarParent = join(target, ...ASAR_PARENT.split('/'))
  mkdirSync(asarParent, { recursive: true })
  copyFileSync(FIXTURE_ASAR as string, join(asarParent, 'default_app.asar'))
  writeFileSync(join(asarParent, 'plain.txt'), 'x', 'utf8')
  return target
}

describe('removeHostTree against a tree holding an asar archive', () => {
  it.runIf(FIXTURE_ASAR)(
    'removes the whole tree under the real Electron binary',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-host-tree-asar-'))
      roots.push(root)
      const bundlePath = join(root, 'host-tree-removal.cjs')
      await bundleHostTreeRemoval(bundlePath)
      const target = buildStrandedTree(root)
      const resultPath = join(root, 'result.json')
      const driverPath = join(root, 'driver.cjs')
      writeFileSync(driverPath, buildDriver(bundlePath, target, resultPath), 'utf8')

      const run = spawnSync(electronBinary, [driverPath], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 60_000
      })
      expect(run.status, run.stderr?.slice(-2000)).toBe(0)

      const probe = JSON.parse(readFileSync(resultPath, 'utf8')) as ProbeResult
      expect(probe).toEqual({ failure: null, residue: [] })
    },
    120_000
  )
})
