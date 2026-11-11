import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../../../src/shared/windows-transient-lock-removal.ts'
import {
  mkTempProject,
  runRebuildScript,
  writeFakeElectronExtractor,
  writeFakeElectronGet,
  writeFakeElectronPackage,
  writeFakeElectronRebuild
} from './rebuild-native-deps-test-fixtures.mjs'

describe('rebuild-native-deps Electron install fallback', () => {
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
})
