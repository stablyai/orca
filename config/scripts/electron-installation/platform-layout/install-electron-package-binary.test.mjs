import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  addSiblingWorktree,
  initGitRepo,
  mkTempProject,
  readSharedDistMarker,
  runInstallScript,
  sharedCacheRoot,
  sharedEntryName,
  sharedEntryNameFor,
  writeFakeElectronDist,
  writeFakeElectronGet,
  writeFakeElectronPackage,
  writeFakeExtractor,
  writeTypeDefPublishFailurePreload
} from './install-electron-package-binary-test-fixtures.mjs'

describe('install-electron-package-binary', () => {
  it('installs the distribution and repairs path.txt', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      writeFakeElectronDist(projectDir, {
        version: 'v40.0.0',
        executableContents: 'old executable',
        pathContents: 'stale-path'
      })

      const result = runInstallScript(projectDir)

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'node_modules', 'electron', 'path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(readFileSync(join(projectDir, 'node_modules/electron/electron.d.ts'), 'utf8')).toBe(
        'replacement types'
      )
      expect(existsSync(join(projectDir, 'node_modules/electron/dist/electron.d.ts'))).toBe(false)
      if (process.platform !== 'win32') {
        expect(
          lstatSync(
            join(projectDir, 'node_modules', 'electron', 'dist', 'version-link')
          ).isSymbolicLink()
        ).toBe(true)
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('restores an existing Electron distribution when publishing its type definitions fails', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      writeFakeElectronDist(projectDir, {
        version: 'v40.0.0',
        executableContents: 'existing executable',
        pathContents: 'electron'
      })
      writeFileSync(join(projectDir, 'node_modules/electron/electron.d.ts'), 'existing types')
      const preloadPath = writeTypeDefPublishFailurePreload(projectDir)

      const result = runInstallScript(projectDir, {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`]
          .filter(Boolean)
          .join(' ')
      })
      const electronDir = join(projectDir, 'node_modules/electron')

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('injected Electron type definition publish failure')
      expect(readFileSync(join(electronDir, 'dist/version'), 'utf8')).toBe('v40.0.0')
      expect(readFileSync(join(electronDir, 'dist/electron'), 'utf8')).toBe('existing executable')
      expect(readFileSync(join(electronDir, 'path.txt'), 'utf8')).toBe('electron')
      expect(readFileSync(join(electronDir, 'electron.d.ts'), 'utf8')).toBe('existing types')
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('shares the Electron dist into a sibling worktree without downloading', () => {
    const projectDir = mkTempProject()
    const siblingDir = `${projectDir}-sibling`

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      expect(runInstallScript(projectDir, { CI: '' }).status).toBe(0)

      addSiblingWorktree(projectDir, siblingDir)
      writeFakeElectronPackage(siblingDir)
      writeFakeElectronGet(siblingDir)
      writeFakeExtractor(siblingDir, { createExecutable: true })

      const result = runInstallScript(siblingDir, { CI: '' })
      const siblingDistDir = join(siblingDir, 'node_modules/electron/dist')

      expect(result.status, result.stderr).toBe(0)
      expect(existsSync(join(siblingDir, 'electron-get.log'))).toBe(false)
      expect(lstatSync(siblingDistDir).isDirectory()).toBe(true)
      expect(lstatSync(siblingDistDir).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(siblingDistDir, 'version'), 'utf8')).toBe('v41.5.0')
      expect(existsSync(join(siblingDistDir, 'electron'))).toBe(true)
      expect(readFileSync(join(siblingDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(readSharedDistMarker(siblingDir)).toBe(sharedEntryName)
    } finally {
      rmSync(siblingDir, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('repairs a corrupt shared Electron dist entry', () => {
    const projectDir = mkTempProject()

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      const entryPath = join(sharedCacheRoot(projectDir), sharedEntryName)
      mkdirSync(entryPath, { recursive: true })
      writeFileSync(join(entryPath, 'version'), 'v40.0.0')
      writeFileSync(join(entryPath, 'electron'), 'stale executable')

      const result = runInstallScript(projectDir, { CI: '' })
      const distDir = join(projectDir, 'node_modules/electron/dist')

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(join(distDir, 'version'), 'utf8')).toBe('v41.5.0')
      expect(readFileSync(join(projectDir, 'node_modules/electron/path.txt'), 'utf8')).toBe(
        'electron'
      )
      expect(readFileSync(join(entryPath, 'version'), 'utf8')).toBe('v41.5.0')
      expect(readSharedDistMarker(projectDir)).toBe(sharedEntryName)
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('gives an Electron upgrade its own cache entry and leaves the old one for other branches', () => {
    const projectDir = mkTempProject()

    try {
      initGitRepo(projectDir)
      writeFakeElectronPackage(projectDir)
      writeFakeElectronGet(projectDir)
      writeFakeExtractor(projectDir, { createExecutable: true })
      expect(runInstallScript(projectDir, { CI: '' }).status).toBe(0)
      expect(readSharedDistMarker(projectDir)).toBe(sharedEntryNameFor('41.5.0'))

      // Upgrade the pinned Electron, exactly as a branch bumping the dependency would.
      writeFakeElectronPackage(projectDir, { version: '42.0.0' })
      writeFakeExtractor(projectDir, { createExecutable: true, version: '42.0.0' })
      const upgraded = runInstallScript(projectDir, { CI: '' })
      const cacheRoot = sharedCacheRoot(projectDir)

      expect(upgraded.status, upgraded.stderr).toBe(0)
      expect(readFileSync(join(projectDir, 'node_modules/electron/dist/version'), 'utf8')).toBe(
        'v42.0.0'
      )
      expect(readSharedDistMarker(projectDir)).toBe(sharedEntryNameFor('42.0.0'))
      expect(readFileSync(join(cacheRoot, sharedEntryNameFor('41.5.0'), 'version'), 'utf8')).toBe(
        'v41.5.0'
      )
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
