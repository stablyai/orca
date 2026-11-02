import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  hashPackagedPluginTree,
  verifyPackagedPluginResources
} = require('./verify-packaged-plugin-resources.cjs')

const FIXTURE_KEY = 'stablyai.orca-multipass-recipes'

/** Copies the launch tree and indexes one shipped pack so byte checks have something to verify. */
async function copyIndexedLaunchTree(resourcesDir) {
  const launchRoot = join(resourcesDir, 'plugins', 'launch')
  await cp(join(process.cwd(), 'resources', 'plugins', 'launch'), launchRoot, { recursive: true })
  await writeFile(
    join(launchRoot, 'bundled-plugins.json'),
    JSON.stringify({
      version: 1,
      plugins: [
        {
          pluginKey: FIXTURE_KEY,
          path: FIXTURE_KEY,
          contentHash: hashPackagedPluginTree(join(launchRoot, FIXTURE_KEY))
        }
      ]
    })
  )
  return launchRoot
}

describe('verify packaged plugin resources', () => {
  it('accepts exact launch bytes copied into a packaged resources directory', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-plugins-'))
    try {
      await cp(
        join(process.cwd(), 'resources', 'plugins', 'launch'),
        join(resourcesDir, 'plugins', 'launch'),
        { recursive: true }
      )

      expect(() => verifyPackagedPluginResources(resourcesDir)).not.toThrow()
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('rejects mutated bytes in the packaged output', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-plugins-'))
    try {
      const launchRoot = await copyIndexedLaunchTree(resourcesDir)
      expect(() => verifyPackagedPluginResources(resourcesDir)).not.toThrow()
      await writeFile(join(launchRoot, FIXTURE_KEY, 'extra.json'), '{"mutated":true}\n')

      expect(() => verifyPackagedPluginResources(resourcesDir)).toThrow(
        `packaged bytes do not match ${FIXTURE_KEY}`
      )
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  it('rejects a CRLF checkout of the launch tree', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-plugins-'))
    try {
      const launchRoot = await copyIndexedLaunchTree(resourcesDir)
      for (const entry of await readdir(launchRoot, { recursive: true })) {
        const path = join(launchRoot, entry)
        if (!(await stat(path)).isFile()) {
          continue
        }
        await writeFile(path, (await readFile(path, 'utf8')).replace(/\r?\n/g, '\r\n'))
      }

      // Every plugin is rewritten; assert first sorted mismatch without pinning reorderable plugin name.
      expect(() => verifyPackagedPluginResources(resourcesDir)).toThrow(
        /packaged bytes do not match stablyai\./
      )
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })
})
