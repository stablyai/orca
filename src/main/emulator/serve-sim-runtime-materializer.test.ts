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
    JSON.stringify({ name: 'serve-sim', dependencies: { ws: '^8', 'not-bundled': '^1' } })
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
    // The dylib must be byte-identical to the bundled (Developer-ID-signed) copy.
    const dylibPath = join(materialized!, 'dist', 'simcam', 'libSimCameraInjector.dylib')
    expect(await readFile(dylibPath)).toEqual(DYLIB_CONTENT)
    expect(clearQuarantine).toHaveBeenCalledTimes(1)
    expect(clearQuarantine).toHaveBeenCalledWith(expect.stringContaining('.staging-1.2.3-'))
    if (process.platform !== 'win32') {
      const helper = join(materialized!, 'dist', 'simcam', 'serve-sim-camera-helper')
      expect(((await stat(helper)).mode & 0o111) !== 0).toBe(true)
    }
  })

  it('returns the existing runtime without re-copying', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const clearQuarantine = vi.fn()
    const options = {
      bundledPackageDir,
      targetRootDir: join(root, 'runtime'),
      version: '1.2.3',
      clearQuarantine
    }

    const first = materializeServeSimRuntime(options)
    const second = materializeServeSimRuntime(options)

    expect(second).toBe(first)
    expect(clearQuarantine).toHaveBeenCalledTimes(1)
  })

  it('prunes runtimes left behind by older app versions', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const targetRootDir = join(root, 'runtime')
    await mkdir(join(targetRootDir, '1.0.0', 'dist'), { recursive: true })
    await writeFile(join(targetRootDir, '1.0.0', 'dist', 'serve-sim.js'), 'old')

    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir,
      version: '1.2.3',
      clearQuarantine: () => {}
    })

    expect(materialized).toBe(join(targetRootDir, '1.2.3', 'node_modules', 'serve-sim'))
    await expect(stat(join(targetRootDir, '1.0.0'))).rejects.toThrow()
  })

  it('tolerates a concurrent instance winning the rename', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const targetRootDir = join(root, 'runtime')
    const winnerNodeModulesDir = join(targetRootDir, '1.2.3', 'node_modules')
    const winnerPackageDir = join(winnerNodeModulesDir, 'serve-sim')

    // Simulate another instance finishing first: right before our rename, drop a
    // complete target dir in place so renameSync fails but the runtime is current.
    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir,
      version: '1.2.3',
      clearQuarantine: () => {
        mkdirSync(join(winnerPackageDir, 'dist'), { recursive: true })
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

  it('returns null when the bundled package is missing', async () => {
    const root = await createRoot()

    const materialized = materializeServeSimRuntime({
      bundledPackageDir: join(root, 'does-not-exist'),
      targetRootDir: join(root, 'runtime'),
      version: '1.2.3',
      clearQuarantine: () => {}
    })

    expect(materialized).toBeNull()
  })

  it('links each bundled dependency next to the copy and skips ones the bundle lacks', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)

    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir: join(root, 'runtime'),
      version: '1.2.3',
      clearQuarantine: () => {}
    })

    const nodeModulesDir = join(root, 'runtime', '1.2.3', 'node_modules')
    expect(materialized).toBe(join(nodeModulesDir, 'serve-sim'))
    expect(realpathSync(join(nodeModulesDir, 'ws'))).toBe(
      realpathSync(join(root, 'bundle', 'node_modules', 'ws'))
    )
    expect((await readdir(nodeModulesDir)).sort()).toEqual(['serve-sim', 'ws'])
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

  it('rebuilds a same-version runtime left in the old flat layout', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const targetRootDir = join(root, 'runtime')
    await mkdir(join(targetRootDir, '1.2.3', 'dist'), { recursive: true })
    await writeFile(join(targetRootDir, '1.2.3', 'dist', 'serve-sim.js'), 'old layout')

    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir,
      version: '1.2.3',
      clearQuarantine: () => {}
    })

    expect(materialized).toBe(join(targetRootDir, '1.2.3', 'node_modules', 'serve-sim'))
    await expect(stat(join(targetRootDir, '1.2.3', 'dist'))).rejects.toThrow()
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

  // Regression: serve-sim 0.1.47's ESM entry imports `ws`, which a bare package copy cannot resolve.
  it('lets the real serve-sim entry resolve every declared dependency from the copy', async () => {
    const root = await createRoot()
    const installedPackageDir = realpathSync(join(process.cwd(), 'node_modules', 'serve-sim'))
    const manifest = JSON.parse(await readFile(join(installedPackageDir, 'package.json'), 'utf8'))
    const dependencyNames = Object.keys(manifest.dependencies ?? {})
    expect(dependencyNames).toContain('ws')
    // Mirror the packaged app: a real serve-sim dir with its dependencies hoisted beside it.
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

    // Probe from the entry's own directory so ESM resolution walks up exactly as serve-sim.js does.
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
