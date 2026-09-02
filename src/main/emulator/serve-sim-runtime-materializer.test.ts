import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { materializeServeSimRuntime } from './serve-sim-runtime-materializer'

const DYLIB_CONTENT = Buffer.from('signed-simcam-dylib-mach-o-bytes')

async function createBundledServeSimPackage(root: string): Promise<string> {
  const packageDir = join(root, 'bundled-serve-sim')
  await mkdir(join(packageDir, 'dist', 'simcam'), { recursive: true })
  await mkdir(join(packageDir, 'bin'), { recursive: true })
  await writeFile(join(packageDir, 'dist', 'serve-sim.js'), 'console.log("serve-sim")')
  await writeFile(join(packageDir, 'dist', 'simcam', 'libSimCameraInjector.dylib'), DYLIB_CONTENT, {
    mode: 0o644
  })
  await writeFile(join(packageDir, 'dist', 'simcam', 'serve-sim-camera-helper'), 'helper', {
    mode: 0o644
  })
  await writeFile(join(packageDir, 'bin', 'serve-sim-bin'), 'bin', { mode: 0o644 })
  return packageDir
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

    expect(materialized).toBe(join(root, 'runtime', '1.2.3'))
    // The dylib must be byte-identical to the bundled (Developer-ID-signed) copy.
    const dylibPath = join(materialized!, 'dist', 'simcam', 'libSimCameraInjector.dylib')
    expect(await readFile(dylibPath)).toEqual(DYLIB_CONTENT)
    expect(clearQuarantine).toHaveBeenCalledTimes(1)
    expect(clearQuarantine).toHaveBeenCalledWith(expect.stringContaining('.staging-1.2.3-'))
    if (process.platform !== 'win32') {
      for (const executable of [
        join(materialized!, 'bin', 'serve-sim-bin'),
        join(materialized!, 'dist', 'simcam', 'serve-sim-camera-helper')
      ]) {
        expect(((await stat(executable)).mode & 0o111) !== 0).toBe(true)
      }
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

    expect(materialized).toBe(join(targetRootDir, '1.2.3'))
    await expect(stat(join(targetRootDir, '1.0.0'))).rejects.toThrow()
  })

  it('tolerates a concurrent instance winning the rename', async () => {
    const root = await createRoot()
    const bundledPackageDir = await createBundledServeSimPackage(root)
    const targetRootDir = join(root, 'runtime')
    const targetDir = join(targetRootDir, '1.2.3')

    // Simulate another instance finishing first: right before our rename, drop a
    // complete target dir in place so renameSync fails but the entry exists.
    const materialized = materializeServeSimRuntime({
      bundledPackageDir,
      targetRootDir,
      version: '1.2.3',
      clearQuarantine: () => {
        mkdirSync(join(targetDir, 'dist'), { recursive: true })
        writeFileSync(join(targetDir, 'dist', 'serve-sim.js'), 'winner')
      }
    })

    expect(materialized).toBe(targetDir)
    expect(await readFile(join(targetDir, 'dist', 'serve-sim.js'), 'utf8')).toBe('winner')
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
})
