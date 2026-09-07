import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'

import {
  mkTempProject,
  runRebuildScript,
  writeFakeElectronExtractor,
  writeFakeElectronGet,
  writeFakeElectronPackage,
  writeFakeElectronRebuild,
  writeFakeUsableElectronPackage
} from './rebuild-native-deps-test-fixtures.mjs'

describe('rebuild-native-deps Electron install fallback', () => {
  it('continues non-strict postinstall when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadRejects: true })
      writeFakeElectronExtractor(projectDir, { createExecutable: false })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir, {
        npm_lifecycle_event: 'postinstall',
        ORCA_STRICT_ELECTRON_INSTALL: ''
      })

      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).toContain(
        'Continuing postinstall because Electron binary installation failed'
      )
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toBe(
        'download attempted\n'
      )
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('fails strict postinstall when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadRejects: true })
      writeFakeElectronExtractor(projectDir, { createExecutable: false })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir, {
        npm_lifecycle_event: 'postinstall',
        ORCA_STRICT_ELECTRON_INSTALL: '1'
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).not.toContain(
        'Continuing postinstall because Electron binary installation failed'
      )
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('fails non-postinstall rebuild commands when Electron retry download fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { downloadRejects: true })
      writeFakeElectronExtractor(projectDir, { createExecutable: false })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Electron install retry failed')
      expect(result.stderr).not.toContain(
        'Continuing postinstall because Electron binary installation failed'
      )
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('preserves partial Electron package contents while retrying install', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { logPartialStateBeforeInstall: true })
      writeFakeElectronExtractor(projectDir, { createExecutable: false })
      writeFakeElectronRebuild(projectDir)
      mkdirSync(join(projectDir, 'node_modules', 'electron', 'dist', 'locales'), {
        recursive: true
      })
      writeFileSync(
        join(projectDir, 'node_modules', 'electron', 'dist', 'locales', 'stale.pak'),
        ''
      )
      writeFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'stale-path')

      const result = runRebuildScript(projectDir, {
        ORCA_STRICT_ELECTRON_INSTALL: '1'
      })

      expect(result.status).toBe(1)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toBe(
        'partial still present\ndownload attempted\n'
      )
      expect(existsSync(join(projectDir, 'node_modules/electron/dist/locales/stale.pak'))).toBe(
        true
      )
      expect(readFileSync(join(projectDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'stale-path'
      )
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('passes the rebuild target to the Electron binary installer', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { logTargetBeforeInstall: true })
      writeFakeElectronExtractor(projectDir, { createExecutable: true })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(
        projectDir,
        { npm_config_platform: '', npm_config_arch: '' },
        ['--platform=linux', '--arch=arm64', '--force']
      )

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toBe(
        'platform=linux arch=arm64\ndownload attempted\n'
      )
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('lets an explicit rebuild target win over inherited installer variables', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeUsableElectronPackage(projectDir, { platform: 'linux' })
      writeFakeElectronGet(projectDir, { logTargetBeforeInstall: true })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(
        projectDir,
        { ELECTRON_INSTALL_PLATFORM: 'win32', ELECTRON_INSTALL_ARCH: 'arm64' },
        ['--platform=linux', '--arch=x64', '--force']
      )

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(projectDir, 'electron-get.log'))).toBe(false)
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('installs the inherited installer target when no rebuild target is passed', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { logTargetBeforeInstall: true })
      writeFakeElectronExtractor(projectDir, { createExecutable: true })
      writeFakeElectronRebuild(projectDir)

      const result = runRebuildScript(projectDir, {
        ELECTRON_INSTALL_PLATFORM: 'win32',
        ELECTRON_INSTALL_ARCH: 'arm64'
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toContain(
        'platform=win32 arch=arm64'
      )
      expect(readFileSync(join(projectDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'electron.exe'
      )
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('falls back to npm config when no rebuild or installer target is set', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir, { logTargetBeforeInstall: true })
      writeFakeElectronExtractor(projectDir, { createExecutable: true })
      writeFakeElectronRebuild(projectDir)

      // runRebuildScript defaults npm_config_platform=linux / npm_config_arch=x64.
      const result = runRebuildScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'electron-get.log'), 'utf8')).toContain(
        'platform=linux arch=x64'
      )
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('repairs existing Electron path metadata without invoking the installer', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeUsableElectronPackage(projectDir)
      writeFakeElectronRebuild(projectDir)
      rmSync(join(projectDir, 'node_modules/electron/path.txt'))

      const result = runRebuildScript(projectDir, {}, ['--platform=linux', '--force'])

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(result.stdout).toContain('Repaired Electron path.txt -> electron')
      expect(existsSync(join(projectDir, 'electron-get.log'))).toBe(false)
    } finally {
      removeTreeSync(projectDir)
    }
  })
})
