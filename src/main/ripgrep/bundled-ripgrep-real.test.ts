import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAppEnvironment, setAppEnvironment } from '../../shared/app-environment'
import { bundledRipgrepBinaryName } from '../../shared/bundled-ripgrep'
import { bundledRipgrepCommand, resetBundledRipgrepPathCacheForTests } from './bundled-ripgrep-path'
import { spawnBundledRipgrep } from './bundled-ripgrep-spawn'

describe('packaged ripgrep execution', () => {
  let fixture: string
  let binary: string
  let workspace: string
  const resourcesPath = process.resourcesPath

  beforeEach(() => {
    resetBundledRipgrepPathCacheForTests()
    const source = bundledRipgrepCommand()
    fixture = mkdtempSync(join(tmpdir(), 'orca bundled rg '))
    const resources = join(fixture, 'resources')
    const platform = `${process.platform}-${process.arch}`
    binary = join(resources, 'ripgrep', platform, bundledRipgrepBinaryName(platform))
    mkdirSync(dirname(binary), { recursive: true })
    copyFileSync(source, binary)
    workspace = join(fixture, 'folder workspace')
    mkdirSync(workspace)
    writeFileSync(join(workspace, '日本語 file.txt'), 'needle\n')
    // A checkout executable must never replace a missing packaged binary.
    writeFileSync(join(workspace, 'rg'), '#!/bin/sh\necho planted\n', { mode: 0o755 })
    writeFileSync(join(workspace, 'rg.exe'), 'planted')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources })
    setAppEnvironment({
      ...getAppEnvironment(),
      isPackaged: () => true,
      getAppPath: () => fixture
    })
    resetBundledRipgrepPathCacheForTests()
  })

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })
    resetBundledRipgrepPathCacheForTests()
    rmSync(fixture, { recursive: true, force: true })
  })

  function search(): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawnBundledRipgrep(['--no-config', '--files-with-matches', 'needle', '.'], {
        cwd: workspace,
        env: { ...process.env, PATH: '' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let output = ''
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        output += chunk
      })
      child.stderr?.resume()
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) {
          resolve(output)
        } else {
          reject(new Error(`ripgrep exited ${code}`))
        }
      })
    })
  }

  it('searches a folder with no PATH tools and spaces in the install and workspace paths', async () => {
    expect(await search()).toContain('日本語 file.txt')
  })

  it('fails when its binary is missing instead of running the workspace executable', async () => {
    rmSync(binary)
    resetBundledRipgrepPathCacheForTests()
    await expect(search()).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
