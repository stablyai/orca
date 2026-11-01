import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

import {
  bundledRipgrepWslSpawnOptions,
  resetBundledRipgrepPathCacheForTests,
  resolveBundledRipgrepPath
} from './bundled-ripgrep-path'

const originalResourcesPath = process.resourcesPath

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value })
}

describe('bundled ripgrep path', () => {
  afterEach(() => {
    setResourcesPath(originalResourcesPath)
    resetBundledRipgrepPathCacheForTests()
  })

  it('prefers the packaged resources copy', () => {
    const resourcesDir = mkdtempSync(join(tmpdir(), 'orca-rg-resources-'))
    try {
      const packaged = join(resourcesDir, 'ripgrep', 'linux-x64', 'rg')
      mkdirSync(join(resourcesDir, 'ripgrep', 'linux-x64'), { recursive: true })
      writeFileSync(packaged, '')
      chmodSync(packaged, 0o755)
      setResourcesPath(resourcesDir)

      expect(resolveBundledRipgrepPath('linux-x64')).toBe(realpathSync(packaged))
    } finally {
      rmSync(resourcesDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'never executes a PATH ripgrep when WSL cannot translate the install drive',
    async () => {
      const { wslShellCommand } = bundledRipgrepWslSpawnOptions(
        'C:\\Orca\\resources\\ripgrep\\linux-x64\\rg'
      )
      const result = await runProcess({
        program: '/bin/bash',
        args: [
          '-c',
          `wslpath() { return 1; }; rg() { echo WRONG_RIPGREP; }; ${wslShellCommand} --version`
        ]
      })
      expect(result.code).toBeGreaterThan(2)
      expect(result.stdout).not.toContain('WRONG_RIPGREP')
    }
  )
})
