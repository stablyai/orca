import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
})
