import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../../../shared/plugins/manifest/plugin-manifest'
import { validatePluginHostCalls } from './plugin-host-call-validation'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function pluginWith(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'orca-host-calls-'))
  dirs.push(root)
  await mkdir(join(root, 'dist'))
  for (const [path, text] of Object.entries(files)) {
    await writeFile(join(root, ...path.split('/')), text)
  }
  const parsed = parsePluginManifest({
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'host-calls',
    name: 'Host calls',
    version: '1.0.0',
    engines: { orca: '>=1.4.259' },
    main: 'dist/main.mjs'
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return { root, manifest: parsed.manifest }
}

describe('validatePluginHostCalls', () => {
  it('refuses a file over the per-file cap without scanning it', async () => {
    const huge = `orca.host.call('workspace.nope')\n${' '.repeat(8 * 1024 * 1024)}`
    const { root, manifest } = await pluginWith({
      'dist/main.mjs': `import './big.js'`,
      'dist/big.js': huge
    })
    expect(await validatePluginHostCalls(root, manifest)).toEqual({
      errors: [],
      warnings: ['dist/big.js: host calls not checked: larger than 8388608 bytes']
    })
  })

  // Why skipped on Windows: creating symlinks there needs elevated rights.
  it.skipIf(process.platform === 'win32')(
    'does not follow a symlink out of the plugin',
    async () => {
      const outside = await mkdtemp(join(tmpdir(), 'orca-host-calls-outside-'))
      dirs.push(outside)
      await writeFile(join(outside, 'leak.js'), `orca.host.call('workspace.nope')`)
      const { root, manifest } = await pluginWith({ 'dist/main.mjs': `import './leak.js'` })
      await symlink(join(outside, 'leak.js'), join(root, 'dist', 'leak.js'))
      expect(await validatePluginHostCalls(root, manifest)).toEqual({
        errors: [],
        warnings: ['dist/leak.js: host calls not checked: a symlink takes it outside the plugin']
      })
    }
  )
})
