import { cpSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { materializeServeSimRuntime } from './serve-sim-runtime-materializer'

const DYLIB_CONTENT = Buffer.from('signed-simcam-dylib-mach-o-bytes')

async function createBundledServeSimPackage(root: string): Promise<string> {
  const nodeModulesDir = join(root, 'bundle', 'node_modules')
  const packageDir = join(nodeModulesDir, 'serve-sim')
  await mkdir(join(packageDir, 'dist', 'simcam'), { recursive: true })
  await mkdir(join(nodeModulesDir, 'ws'), { recursive: true })
  await writeFile(join(nodeModulesDir, 'ws', 'package.json'), '{"name":"ws"}')
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({
      name: 'serve-sim',
      version: '0.1.47',
      dependencies: { ws: '^8', 'not-bundled': '^1' }
    })
  )
  await writeFile(join(packageDir, 'dist', 'serve-sim.js'), 'console.log("serve-sim")')
  await writeFile(join(packageDir, 'dist', 'simcam', 'libSimCameraInjector.dylib'), DYLIB_CONTENT, {
    mode: 0o644
  })
  await writeFile(join(packageDir, 'dist', 'simcam', 'serve-sim-camera-helper'), 'helper', {
    mode: 0o755
  })
  return packageDir
}

function symlinkDir(target: string, path: string): void {
  // 'junction' lets Windows create the link without symlink privilege; POSIX ignores it.
  symlinkSync(target, path, 'junction')
}

describe('materializeServeSimRuntime', () => {
  const cleanupPaths: string[] = []

  afterEach(async () => {
    for (const path of cleanupPaths.splice(0)) {
      await rm(path, { recursive: true, force: true })
    }
  })

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-simcam-materializer-'))
    cleanupPaths.push(root)
    return root
  }

  it('copies the signed dylib through unchanged and clears quarantine', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const clearQuarantine = vi.fn()

    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir: join(root, 'runtime'),
      version: '1.2.3',
      clearQuarantine
    })

    expect(materialized).toBe(join(root, 'runtime', '1.2.3', 'node_modules', 'serve-sim'))
    const dylibPath = join(materialized!, 'dist', 'simcam', 'libSimCameraInjector.dylib')
    expect(await readFile(dylibPath)).toEqual(DYLIB_CONTENT)
    expect(clearQuarantine).toHaveBeenCalledTimes(1)
    expect(clearQuarantine).toHaveBeenCalledWith(expect.stringContaining('.staging-1.2.3-'))
    if (process.platform !== 'win32') {
      const helper = join(materialized!, 'dist', 'simcam', 'serve-sim-camera-helper')
      expect(((await stat(helper)).mode & 0o111) !== 0).toBe(true)
    }
  })

  it('tolerates a concurrent instance winning the rename', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const targetRootDir = join(root, 'runtime')
    const winnerNodeModulesDir = join(targetRootDir, '1.2.3', 'node_modules')
    const winnerPackageDir = join(winnerNodeModulesDir, 'serve-sim')

    // Simulate another instance publishing a complete runtime just before our rename.
    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir,
      version: '1.2.3',
      clearQuarantine: () => {
        mkdirSync(join(winnerPackageDir, 'dist'), { recursive: true })
        cpSync(join(bundledPackageDir, 'package.json'), join(winnerPackageDir, 'package.json'))
        writeFileSync(join(winnerPackageDir, 'dist', 'serve-sim.js'), 'winner')
        symlinkDir(join(root, 'bundle', 'node_modules', 'ws'), join(winnerNodeModulesDir, 'ws'))
      }
    })

    expect(materialized).toBe(winnerPackageDir)
    expect(await readFile(join(winnerPackageDir, 'dist', 'serve-sim.js'), 'utf8')).toBe('winner')
    const leftovers = (await readdir(targetRootDir)).filter((name) => name.startsWith('.staging'))
    expect(leftovers).toEqual([])
  })

  it('returns null and leaves no staging behind when quarantine clearing fails', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const targetRootDir = join(root, 'runtime')

    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir,
      version: '1.2.3',
      clearQuarantine: () => {
        throw new Error('xattr failed')
      }
    })

    expect(materialized).toBeNull()
    await expect(stat(join(targetRootDir, '1.2.3'))).rejects.toThrow()
    const leftovers = (await readdir(targetRootDir)).filter((name) => name.startsWith('.staging'))
    expect(leftovers).toEqual([])
  })

  it('clears quarantine on the copied package before linking into the bundle', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const seenEntries: string[][] = []

    materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir: join(root, 'runtime'),
      version: '1.2.3',
      clearQuarantine: (dir) => {
        seenEntries.push([dir, ...readdirSync(join(dir, '..'))])
      }
    })

    expect(seenEntries).toHaveLength(1)
    expect(seenEntries[0][0]).toMatch(/\.staging-1\.2\.3-\d+[/\\]node_modules[/\\]serve-sim$/)
    expect(seenEntries[0].slice(1)).toEqual(['serve-sim'])
  })

  it('replaces a cached helper after a dependency upgrade without an app version change', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const options = {
      bundledPackageDir,
      targetRootDir: join(root, 'runtime'),
      version: '1.2.3',
      clearQuarantine: () => {}
    }
    materializeServeSimRuntime(options)
    await writeFile(
      join(bundledPackageDir, 'package.json'),
      JSON.stringify({ name: 'serve-sim', version: '0.1.49', dependencies: { ws: '^8' } })
    )
    await writeFile(join(bundledPackageDir, 'dist', 'serve-sim.js'), 'upgraded helper')

    const materialized = materializeServeSimRuntime(options)

    expect(materialized).not.toBeNull()
    expect(await readFile(join(materialized!, 'dist', 'serve-sim.js'), 'utf8')).toBe(
      'upgraded helper'
    )
  })

  it('rebuilds when the app moved and the dependency links dangle', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const targetRootDir = join(root, 'runtime')
    materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir,
      version: '1.2.3',
      clearQuarantine: () => {}
    })
    await rename(join(root, 'bundle'), join(root, 'moved-bundle'))
    const movedPackageDir = join(root, 'moved-bundle', 'node_modules', 'serve-sim')

    const materialized = materializeServeSimRuntime({
      bundledPackageDir: movedPackageDir,
      targetRootDir,
      version: '1.2.3',
      clearQuarantine: () => {}
    })

    expect(materialized).toBe(join(targetRootDir, '1.2.3', 'node_modules', 'serve-sim'))
    expect(await readlink(join(targetRootDir, '1.2.3', 'node_modules', 'ws'))).toContain(
      'moved-bundle'
    )
  })

  // The copied ESM entry must resolve dependencies such as ws outside the original package.
  it('lets the real serve-sim entry resolve every declared dependency from the copy', async () => {
    const root = await createRoot()
    const installedPackageDir = realpathSync(join(process.cwd(), 'node_modules', 'serve-sim'))
    const manifest = JSON.parse(await readFile(join(installedPackageDir, 'package.json'), 'utf8'))
    const dependencyNames = Object.keys(manifest.dependencies ?? {})
    expect(dependencyNames).toContain('ws')
    const bundledNodeModulesDir = join(root, 'Resources', 'node_modules')
    const bundledPackageDir = join(bundledNodeModulesDir, 'serve-sim')
    cpSync(installedPackageDir, bundledPackageDir, { recursive: true })
    for (const name of dependencyNames) {
      symlinkDir(join(installedPackageDir, '..', name), join(bundledNodeModulesDir, name))
    }

    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir: join(root, 'runtime'),
      version: '1.2.3',
      clearQuarantine: () => {}
    })
    expect(materialized).not.toBeNull()

    // Probe beside the entry to exercise the same ESM resolution paths.
    const probePath = join(materialized!, 'dist', 'orca-dependency-probe.mjs')
    await writeFile(
      probePath,
      `for (const name of ${JSON.stringify(dependencyNames)}) import.meta.resolve(name)\n`
    )
    const result = await runProcess({ program: process.execPath, args: [probePath] })

    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
  })
})
