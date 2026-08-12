import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installPluginFromLocalPath,
  installPluginFromGit,
  PLUGIN_LOCKFILE_MAX_BYTES,
  readPluginLockfile,
  removeInstalledPlugin
} from './plugin-install'
import { PLUGIN_MANIFEST_MAX_BYTES } from './plugin-manifest-file'
import { readPluginCurrentPointer } from './plugin-current-pointer'
import { writePluginLockfile } from './plugin-install-lockfile-store'
import { installStagedPluginTree } from './plugin-install-staging'
import * as manifestFile from './plugin-manifest-file'

const roots: string[] = []
const execFileAsync = promisify(execFile)

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function writePluginSource(
  root: string,
  options: { id?: string; panelEntry?: string; includePanel?: boolean } = {}
): Promise<void> {
  const panelEntry = options.panelEntry ?? 'panel.html'
  await writeFile(
    join(root, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: options.id ?? 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      contributes: {
        panels: [{ id: 'panel', title: 'Panel', entry: panelEntry }],
        commands: [],
        events: []
      },
      capabilities: []
    })
  )
  if (options.includePanel !== false) {
    await writeFile(join(root, panelEntry), '<h1>Panel</h1>')
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('installPluginFromLocalPath', () => {
  it('refuses to allocate an oversized install lockfile', async () => {
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    const lockPath = join(pluginsDir, 'plugins.lock.json')
    await writeFile(lockPath, '')
    await truncate(lockPath, PLUGIN_LOCKFILE_MAX_BYTES + 1)

    await expect(readPluginLockfile(pluginsDir)).resolves.toEqual({ version: 1, plugins: {} })
  })

  it('verifies copied content and writes a rollback-compatible consent field', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)

    const result = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    await expect(
      readFile(join(pluginsDir, result.pluginKey, result.contentHash, 'panel.html'), 'utf8')
    ).resolves.toBe('<h1>Panel</h1>')
    const lock = JSON.parse(await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')) as {
      plugins: Record<string, Record<string, unknown>>
    }
    expect(lock.plugins[result.pluginKey]).toMatchObject({
      capabilityHash: result.consentFingerprint
    })
    expect(lock.plugins[result.pluginKey]).not.toHaveProperty('consentFingerprint')
  })

  it('publishes metadata from the copied immutable manifest', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    const firstManifest = await readFile(join(sourcePath, 'orca-plugin.json'), 'utf8')
    const changedManifest = {
      ...(JSON.parse(firstManifest) as Record<string, unknown>),
      name: 'Changed During Staging',
      version: '2.0.0'
    }
    await writeFile(join(sourcePath, 'orca-plugin.json'), JSON.stringify(changedManifest))
    const manifestRead = vi
      .spyOn(manifestFile, 'readPluginManifestText')
      .mockResolvedValueOnce(firstManifest)

    const result = await installStagedPluginTree({
      pluginsDir,
      stagingDir: sourcePath,
      hostVersion: '1.4.0',
      source: { kind: 'local-path', path: sourcePath },
      resolvedCommit: null
    })

    expect(manifestRead).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ ok: true, version: '2.0.0' })
    if (result.ok) {
      const lock = await readPluginLockfile(pluginsDir)
      expect(lock.plugins[result.pluginKey]?.version).toBe('2.0.0')
    }
  })

  it('skips root Git metadata before copying while still enforcing plugin limits', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    const gitDir = join(sourcePath, '.git')
    await mkdir(gitDir)
    await writeFile(join(gitDir, 'large.pack'), '')
    await truncate(join(gitDir, 'large.pack'), 50 * 1024 * 1024 + 1)

    const result = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })

    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      await expect(
        readFile(join(pluginsDir, result.pluginKey, result.contentHash, '.git', 'large.pack'))
      ).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('restores the previous current pointer when lockfile publication fails', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    const first = await installPluginFromLocalPath({ pluginsDir, sourcePath, hostVersion: '1.4.0' })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    await writeFile(join(sourcePath, 'panel.html'), '<h1>Updated</h1>')
    await rm(join(pluginsDir, 'plugins.lock.json'))
    await mkdir(join(pluginsDir, 'plugins.lock.json'))

    const failed = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })

    expect(failed).toMatchObject({ ok: false })
    await expect(readPluginCurrentPointer(join(pluginsDir, first.pluginKey))).resolves.toBe(
      first.contentHash
    )
  })

  it('does not replace provenance when a same-content reinstall fails to publish', async () => {
    const firstSource = await tempRoot('orca-plugin-source-')
    const secondSource = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(firstSource)
    await writePluginSource(secondSource)
    const first = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: firstSource,
      hostVersion: '1.4.0'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    const acceptedLock = await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')
    await rm(join(pluginsDir, 'plugins.lock.json'))
    await mkdir(join(pluginsDir, 'plugins.lock.json'))

    const failed = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: secondSource,
      hostVersion: '1.4.0'
    })
    expect(failed).toMatchObject({ ok: false })

    await rm(join(pluginsDir, 'plugins.lock.json'), { recursive: true })
    await writeFile(join(pluginsDir, 'plugins.lock.json'), acceptedLock)
    const recovered = await readPluginLockfile(pluginsDir)
    expect(recovered.plugins[first.pluginKey]?.source).toEqual({
      kind: 'local-path',
      path: firstSource
    })
  })

  it('preserves legacy lock provenance during a same-content reinstall', async () => {
    const firstSource = await tempRoot('orca-plugin-source-')
    const secondSource = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(firstSource)
    await writePluginSource(secondSource)
    const first = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: firstSource,
      hostVersion: '1.4.0'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    await rm(join(pluginsDir, first.pluginKey, '.install-provenance', `${first.contentHash}.json`))
    const reinstalled = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath: secondSource,
      hostVersion: '1.4.0'
    })
    expect(reinstalled).toMatchObject({ ok: true })

    // Recovery from the newly backfilled provenance must retain the accepted
    // legacy source rather than the same-byte reinstall's alternate source.
    await rm(join(pluginsDir, 'plugins.lock.json'))
    const recovered = await readPluginLockfile(pluginsDir)
    expect(recovered.plugins[first.pluginKey]?.source).toEqual({
      kind: 'local-path',
      path: firstSource
    })
  })

  it('retains only the current and immediately previous content versions', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    const hashes: string[] = []
    for (const content of ['one', 'two', 'three']) {
      await writeFile(join(sourcePath, 'panel.html'), `<h1>${content}</h1>`)
      const result = await installPluginFromLocalPath({
        pluginsDir,
        sourcePath,
        hostVersion: '1.4.0'
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        hashes.push(result.contentHash)
      }
    }

    const versionDirs = (
      await readdir(join(pluginsDir, 'orca-samples.demo'), {
        withFileTypes: true
      })
    )
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    expect(versionDirs).toEqual(hashes.slice(-2).sort())
  })

  it('keeps the rollback version when current content is reinstalled', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    const hashes: string[] = []
    for (const content of ['one', 'two', 'two']) {
      await writeFile(join(sourcePath, 'panel.html'), `<h1>${content}</h1>`)
      const result = await installPluginFromLocalPath({
        pluginsDir,
        sourcePath,
        hostVersion: '1.4.0'
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        hashes.push(result.contentHash)
      }
    }

    const versionDirs = (
      await readdir(join(pluginsDir, 'orca-samples.demo'), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    expect(versionDirs).toEqual([...new Set(hashes)].sort())
  })

  it('repairs a pointer-new lock-old interrupted publication from provenance', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    const first = await installPluginFromLocalPath({ pluginsDir, sourcePath, hostVersion: '1.4.0' })
    expect(first.ok).toBe(true)
    const oldLock = await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')
    await writeFile(join(sourcePath, 'panel.html'), '<h1>new current</h1>')
    const second = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      return
    }

    await writeFile(join(pluginsDir, 'plugins.lock.json'), oldLock)
    const repaired = await readPluginLockfile(pluginsDir)

    expect(repaired.plugins[second.pluginKey]?.contentHash).toBe(second.contentHash)
    const persisted = JSON.parse(await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')) as {
      plugins: Record<string, { contentHash?: string }>
    }
    expect(persisted.plugins[second.pluginKey]?.contentHash).toBe(second.contentHash)
  })

  it('rejects a manifest whose declared panel artifact is missing', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath, { includePanel: false })

    const result = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })

    expect(result).toMatchObject({ ok: false })
  })

  it('rejects an oversized manifest without reading an unbounded JSON payload', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    const manifestPath = join(sourcePath, 'orca-plugin.json')
    await writeFile(manifestPath, '')
    await truncate(manifestPath, PLUGIN_MANIFEST_MAX_BYTES + 1)

    const result = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('exceeds') })
  })

  it('serializes concurrent installs so lockfile entries are not lost', async () => {
    const firstSource = await tempRoot('orca-plugin-source-')
    const secondSource = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(firstSource, { id: 'first' })
    await writePluginSource(secondSource, { id: 'second' })

    const results = await Promise.all([
      installPluginFromLocalPath({ pluginsDir, sourcePath: firstSource, hostVersion: '1.4.0' }),
      installPluginFromLocalPath({ pluginsDir, sourcePath: secondSource, hostVersion: '1.4.0' })
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    const lock = JSON.parse(await readFile(join(pluginsDir, 'plugins.lock.json'), 'utf8')) as {
      plugins: Record<string, unknown>
    }
    expect(Object.keys(lock.plugins).sort()).toEqual(['orca-samples.first', 'orca-samples.second'])
  })

  it('serializes concurrent lockfile publications without temporary-file collisions', async () => {
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    const lock = { version: 1 as const, plugins: {} }

    await expect(
      Promise.all([
        writePluginLockfile(pluginsDir, lock),
        writePluginLockfile(pluginsDir, lock),
        writePluginLockfile(pluginsDir, lock)
      ])
    ).resolves.toHaveLength(3)
    await expect(readPluginLockfile(pluginsDir)).resolves.toEqual(lock)
  })

  it('refuses to repoint at a tampered existing content directory', async () => {
    const sourcePath = await tempRoot('orca-plugin-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    const first = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      return
    }
    await writeFile(
      join(pluginsDir, first.pluginKey, first.contentHash, 'panel.html'),
      '<h1>Tampered</h1>'
    )

    const second = await installPluginFromLocalPath({
      pluginsDir,
      sourcePath,
      hostVersion: '1.4.0'
    })

    expect(second).toMatchObject({
      ok: false,
      error: expect.stringContaining('integrity verification')
    })
  })
})

describe('installPluginFromGit', () => {
  it('uses system Git, resolves the requested ref, and installs its exact bytes', async () => {
    const sourcePath = await tempRoot('orca-plugin-git-source-')
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    await writePluginSource(sourcePath)
    await execFileAsync('git', ['init', '--quiet'], { cwd: sourcePath })
    await execFileAsync('git', ['config', 'user.email', 'plugins@example.invalid'], {
      cwd: sourcePath
    })
    await execFileAsync('git', ['config', 'user.name', 'Plugin Test'], { cwd: sourcePath })
    await execFileAsync('git', ['add', '.'], { cwd: sourcePath })
    await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: sourcePath })
    await execFileAsync('git', ['tag', 'v1.0.0'], { cwd: sourcePath })
    const { stdout: commitStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: sourcePath
    })

    const configKeys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
    const previous = Object.fromEntries(configKeys.map((key) => [key, process.env[key]]))
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(sourcePath).href}.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://plugin.test/demo.git'
    try {
      const result = await installPluginFromGit({
        pluginsDir,
        url: 'https://plugin.test/demo.git',
        ref: 'v1.0.0',
        hostVersion: '1.4.0'
      })

      expect(result).toMatchObject({ ok: true, resolvedCommit: commitStdout.trim() })
      if (result.ok) {
        await expect(
          readFile(join(pluginsDir, result.pluginKey, result.contentHash, 'panel.html'), 'utf8')
        ).resolves.toBe('<h1>Panel</h1>')
      }
    } finally {
      for (const key of configKeys) {
        const value = previous[key]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })
})

describe('removeInstalledPlugin', () => {
  it('rejects an unqualified or traversing key before removing anything', async () => {
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    const pluginsDataDir = await tempRoot('orca-plugin-data-')
    const outside = join(await tempRoot('orca-plugin-outside-'), 'keep.txt')
    await writeFile(outside, 'keep')

    await expect(
      removeInstalledPlugin({ pluginsDir, pluginsDataDir, pluginKey: '../outside' })
    ).rejects.toThrow('invalid qualified plugin key')
    await expect(readFile(outside, 'utf8')).resolves.toBe('keep')
  })

  it('rejects a resolved uninstall target outside its root', async () => {
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    const pluginsDataDir = await tempRoot('orca-plugin-data-')
    const outside = await tempRoot('orca-plugin-outside-')
    const marker = join(outside, 'keep.txt')
    await writeFile(marker, 'keep')
    await symlink(
      outside,
      join(pluginsDir, 'orca-samples.demo'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    await expect(
      removeInstalledPlugin({
        pluginsDir,
        pluginsDataDir,
        pluginKey: 'orca-samples.demo'
      })
    ).rejects.toThrow('outside')
    await expect(readFile(marker, 'utf8')).resolves.toBe('keep')
  })

  it('removes qualified install and data directories', async () => {
    const pluginsDir = await tempRoot('orca-plugin-installs-')
    const pluginsDataDir = await tempRoot('orca-plugin-data-')
    const key = 'orca-samples.demo'
    await mkdir(join(pluginsDir, key))
    await mkdir(join(pluginsDataDir, key))
    await writeFile(join(pluginsDir, key, 'content'), 'installed')
    await writeFile(join(pluginsDataDir, key, 'storage.json'), '{}')

    await removeInstalledPlugin({ pluginsDir, pluginsDataDir, pluginKey: key })

    await expect(readFile(join(pluginsDir, key, 'content'))).rejects.toThrow()
    await expect(readFile(join(pluginsDataDir, key, 'storage.json'))).rejects.toThrow()
  })
})
