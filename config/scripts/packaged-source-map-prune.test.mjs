import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  prunePackagedRuntimeTypeAndSourceMapArtifacts,
  prunePackagedRuntimeNodeModules
} = require('../packaged-runtime-node-modules.cjs')

const LINEAR_SDK_PACKAGE_JSON =
  '{"name":"@linear/sdk","type":"module","main":"./dist/index.cjs","exports":{".":{"require":"./dist/index.cjs","import":"./dist/index.mjs"}}}'

async function createPackagedNodeModulesFixture(resourcesDir) {
  const packageDir = join(resourcesDir, 'node_modules', '@linear', 'sdk')
  const distDir = join(packageDir, 'dist')
  const webhooksDir = join(packageDir, 'webhooks')
  const updaterDir = join(resourcesDir, 'node_modules', 'electron-updater', 'out')
  const jsYamlDir = join(resourcesDir, 'node_modules', 'js-yaml', 'dist')
  const nodePtyDir = join(resourcesDir, 'node_modules', 'node-pty', 'lib')
  await mkdir(distDir, { recursive: true })
  await mkdir(webhooksDir, { recursive: true })
  await mkdir(updaterDir, { recursive: true })
  await mkdir(jsYamlDir, { recursive: true })
  await mkdir(nodePtyDir, { recursive: true })
  await writeFile(join(packageDir, 'package.json'), LINEAR_SDK_PACKAGE_JSON, 'utf8')
  await writeFile(join(packageDir, 'README.md'), 'SDK documentation', 'utf8')
  await writeFile(join(packageDir, 'metadata.json.map'), '{"keep":true}', 'utf8')
  await writeFile(
    join(distDir, 'index.cjs'),
    "module.exports = require('./runtime-helper.cjs')",
    'utf8'
  )
  await writeFile(
    join(distDir, 'runtime-helper.cjs'),
    'exports.LinearClient = class LinearClient {}',
    'utf8'
  )
  await writeFile(join(distDir, 'index.mjs'), 'export {}', 'utf8')
  await writeFile(join(distDir, 'index.cjs.map'), '{}', 'utf8')
  await writeFile(join(distDir, 'index.mjs.map'), '{}', 'utf8')
  await writeFile(join(webhooksDir, 'index.cjs'), 'module.exports = {}', 'utf8')
  await writeFile(join(webhooksDir, 'index.cjs.map'), '{}', 'utf8')
  await writeFile(join(updaterDir, 'main.js'), 'module.exports = {}', 'utf8')
  await writeFile(join(updaterDir, 'main.js.map'), '{}', 'utf8')
  await writeFile(join(updaterDir, 'main.d.ts'), 'export {}', 'utf8')
  await writeFile(join(updaterDir, 'main.d.ts.map'), '{}', 'utf8')
  await writeFile(join(jsYamlDir, 'js-yaml.min.js'), 'globalThis.jsyaml = {}', 'utf8')
  await writeFile(join(jsYamlDir, 'js-yaml.min.js.map'), '{}', 'utf8')
  await writeFile(join(nodePtyDir, 'index.js'), 'module.exports = {}', 'utf8')
  await writeFile(join(nodePtyDir, 'index.js.map'), '{}', 'utf8')
  return { packageDir, distDir, webhooksDir, updaterDir, jsYamlDir, nodePtyDir }
}

describe('packaged runtime type-declaration and source-map pruning', () => {
  it('removes @linear/sdk source maps while preserving runtime files and non-JS maps', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-source-map-prune-'))
    try {
      const { packageDir, distDir, webhooksDir } =
        await createPackagedNodeModulesFixture(resourcesDir)

      prunePackagedRuntimeTypeAndSourceMapArtifacts(resourcesDir)

      await expect(readdir(distDir).then((entries) => entries.sort())).resolves.toEqual([
        'index.cjs',
        'index.mjs',
        'runtime-helper.cjs'
      ])
      await expect(readdir(webhooksDir)).resolves.toEqual(['index.cjs'])
      await expect(readFile(join(packageDir, 'package.json'), 'utf8')).resolves.toBe(
        LINEAR_SDK_PACKAGE_JSON
      )
      await expect(readFile(join(packageDir, 'README.md'), 'utf8')).resolves.toBe(
        'SDK documentation'
      )
      // Why: the predicate is filename-based, so a non-JS `.map` payload must survive.
      await expect(readFile(join(packageDir, 'metadata.json.map'), 'utf8')).resolves.toBe(
        '{"keep":true}'
      )
      const sdk = createRequire(join(resourcesDir, 'consumer.cjs'))('@linear/sdk')
      expect(typeof sdk.LinearClient).toBe('function')
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('removes source maps from every packaged dependency, not just @linear/sdk', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-source-map-prune-all-'))
    try {
      const { jsYamlDir, nodePtyDir } = await createPackagedNodeModulesFixture(resourcesDir)

      prunePackagedRuntimeTypeAndSourceMapArtifacts(resourcesDir)

      await expect(readdir(jsYamlDir)).resolves.toEqual(['js-yaml.min.js'])
      await expect(readdir(nodePtyDir)).resolves.toEqual(['index.js'])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('removes type declarations and declaration maps in the same walk', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-source-map-prune-dts-'))
    try {
      const { updaterDir } = await createPackagedNodeModulesFixture(resourcesDir)

      prunePackagedRuntimeTypeAndSourceMapArtifacts(resourcesDir)

      await expect(readdir(updaterDir)).resolves.toEqual(['main.js'])
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('runs the artifact prune through aggregate runtime cleanup', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-source-map-aggregate-prune-'))
    try {
      const { distDir, updaterDir, packageDir } =
        await createPackagedNodeModulesFixture(resourcesDir)

      prunePackagedRuntimeNodeModules(resourcesDir, 'darwin', 'arm64')

      await expect(readdir(distDir).then((entries) => entries.sort())).resolves.toEqual([
        'index.cjs',
        'index.mjs',
        'runtime-helper.cjs'
      ])
      await expect(readdir(updaterDir)).resolves.toEqual(['main.js'])
      await expect(readFile(join(packageDir, 'metadata.json.map'), 'utf8')).resolves.toBe(
        '{"keep":true}'
      )
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })
})
