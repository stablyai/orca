import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyPackagedPluginResources } = require('./verify-packaged-plugin-resources.cjs')

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
      const launchRoot = join(resourcesDir, 'plugins', 'launch')
      await cp(join(process.cwd(), 'resources', 'plugins', 'launch'), launchRoot, {
        recursive: true
      })
      await writeFile(
        join(launchRoot, 'stablyai.orca-navigation-shortcuts', 'extra.json'),
        '{"mutated":true}\n'
      )

      expect(() => verifyPackagedPluginResources(resourcesDir)).toThrow(
        'packaged bytes do not match stablyai.orca-navigation-shortcuts'
      )
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  // The tree is hashed by raw bytes, so a CRLF checkout on Windows breaks the
  // pinned hash. These two guard the `.gitattributes` eol=lf pin that prevents it.
  // Asserted through check-attr, not against the text of `.gitattributes`: what matters
  // is the attribute Git resolves, whichever rule supplies it. `text` is asserted as
  // well as `eol` — under `-text` Git copies the blob verbatim, so an LF checkout would
  // depend on the blob staying LF rather than on the pin.
  it('pins the launch tree to LF so Windows checkouts hash identically', () => {
    const resolved = spawnSync(
      'git',
      ['check-attr', 'text', 'eol', '--', 'resources/plugins/launch/bundled-plugins.json'],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(resolved.status).toBe(0)
    const [text, eol] = resolved.stdout
      .trim()
      .split('\n')
      .map((line) => line.split(': ').at(-1))
    // `auto` or `set`: either means Git converts on checkout. `unset` (`-text`) does not.
    expect(['auto', 'set']).toContain(text)
    expect(eol).toBe('lf')
  })

  it('rejects a CRLF checkout of the launch tree', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-packaged-plugins-'))
    try {
      const launchRoot = join(resourcesDir, 'plugins', 'launch')
      await cp(join(process.cwd(), 'resources', 'plugins', 'launch'), launchRoot, {
        recursive: true
      })
      for (const entry of await readdir(launchRoot, { recursive: true })) {
        const path = join(launchRoot, entry)
        if (!(await stat(path)).isFile()) {
          continue
        }
        await writeFile(path, (await readFile(path, 'utf8')).replace(/\r?\n/g, '\r\n'))
      }

      // Every file is rewritten, so the first mismatch is whichever plugin sorts
      // first — don't pin a name a later branch can reorder.
      expect(() => verifyPackagedPluginResources(resourcesDir)).toThrow(
        /packaged bytes do not match stablyai\./
      )
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })
})
