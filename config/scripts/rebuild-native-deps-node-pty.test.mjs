import { existsSync, readFileSync } from 'node:fs'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  mkTempProject,
  runRebuildScript,
  writeFakeElectronRebuild,
  writeFakeLoadableNodePty,
  writeFakeNodePtyConptyPayload,
  writeFakeUsableElectronPackage,
  writeFakeWindowsProcessTree,
  writeFakeWindowsProcessTreeWithNodeAddonApi,
  writeFakeWindowsRegistry,
  writeNodePtyPatchFile,
  writePatchedNodePtyBuildArtifacts
} from './rebuild-native-deps-test-fixtures.mjs'

describe('rebuild-native-deps patched node-pty rebuild', () => {
  it.skipIf(process.platform !== 'win32')(
    'repairs a missing ConPTY runtime before probing without recompiling node-pty',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { nativeDir: '../build/Release/' })
        writeFakeWindowsRegistry(projectDir)
        writeFakeWindowsProcessTree(projectDir)
        writeFakeNodePtyConptyPayload(projectDir, process.arch)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath,
          npm_config_platform: 'win32',
          npm_config_arch: process.arch
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('Restored node-pty ConPTY runtime files')
        expect(result.stdout).toContain(
          'Native modules already load in Electron; skipping rebuild.'
        )
        expect(existsSync(rebuildLogPath)).toBe(false)
      } finally {
        removeTreeSync(projectDir)
      }
    }
  )

  it('stages windows-process-tree node-addon-api headers before a Windows rebuild', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir)
      writeFakeNodePtyConptyPayload(projectDir, 'x64')
      writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)

      const result = runRebuildScript(
        projectDir,
        { npm_config_platform: 'win32', npm_config_arch: 'x64' },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status, result.stderr).toBe(0)
      expect(
        readFileSync(
          join(
            projectDir,
            'node_modules',
            '@vscode',
            'windows-process-tree',
            'deps',
            'node-addon-api',
            'napi.h'
          ),
          'utf8'
        )
      ).toBe('// napi.h\n')
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('restores the ConPTY runtime payload after a Windows Electron rebuild', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir)
      writeFakeNodePtyConptyPayload(projectDir, 'x64')

      const result = runRebuildScript(
        projectDir,
        { npm_config_platform: 'win32', npm_config_arch: 'x64' },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Restored node-pty ConPTY runtime files for win10-x64')
      const runtimeDir = join(projectDir, 'node_modules', 'node-pty', 'build', 'Release', 'conpty')
      expect(readFileSync(join(runtimeDir, 'conpty.dll'), 'utf8')).toBe('conpty.dll x64')
      expect(readFileSync(join(runtimeDir, 'OpenConsole.exe'), 'utf8')).toBe('OpenConsole.exe x64')
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'does not rebuild a healthy node-pty when another Windows addon fails its probe',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir)
        writeFakeWindowsProcessTree(projectDir)
        writeFakeNodePtyConptyPayload(projectDir, process.arch)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath,
          npm_config_platform: 'win32',
          npm_config_arch: process.arch
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('Rebuilding failed native modules: windows-native-registry')
        const rebuildCall = JSON.parse(readFileSync(rebuildLogPath, 'utf8').trim())
        expect(rebuildCall.onlyModules).toEqual(['windows-native-registry'])
      } finally {
        removeTreeSync(projectDir)
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'rebuilds a loadable ConPTY native that lacks Orca job ownership',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { ownsPtyJob: false })
        writeFakeWindowsRegistry(projectDir)
        writeFakeWindowsProcessTree(projectDir)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath,
          npm_config_platform: 'win32',
          npm_config_arch: process.arch
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('Rebuilding failed native modules: node-pty')
        expect(result.stdout).toContain('missing listJobProcessIds')
        const rebuildCall = JSON.parse(readFileSync(rebuildLogPath, 'utf8').trim())
        expect(rebuildCall.onlyModules).toEqual(['node-pty'])
      } finally {
        removeTreeSync(projectDir)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rebuilds when Electron can load node-pty but patched build artifacts are missing',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir)
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir)
        writeNodePtyPatchFile(projectDir)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain(
          'Patched node-pty build artifacts are missing; rebuilding from source.'
        )

        const rebuildCall = JSON.parse(readFileSync(rebuildLogPath, 'utf8').trim())
        expect(rebuildCall.onlyModules).toEqual(['node-pty'])
        expect(rebuildCall.ignoreModules).toEqual(['cpu-features'])
        expect(rebuildCall.force).toBe(true)
      } finally {
        removeTreeSync(projectDir)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps the Electron load-probe fast path once patched node-pty artifacts exist',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir)
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { nativeDir: '../build/Release/' })
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain(
          'Native modules already load in Electron; skipping rebuild.'
        )
        expect(existsSync(rebuildLogPath)).toBe(false)
      } finally {
        removeTreeSync(projectDir)
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rebuilds when patched artifacts exist but Electron falls back to node-pty prebuilds',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir)
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { nativeDir: '../prebuilds/darwin-arm64/' })
        writeNodePtyPatchFile(projectDir)
        writePatchedNodePtyBuildArtifacts(projectDir)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('Rebuilding failed native modules: node-pty')
        expect(result.stdout).toContain("expected build/Release so Orca's node-pty patch is active")

        const rebuildCall = JSON.parse(readFileSync(rebuildLogPath, 'utf8').trim())
        expect(rebuildCall.onlyModules).toEqual(['node-pty'])
        expect(rebuildCall.force).toBe(true)
      } finally {
        removeTreeSync(projectDir)
      }
    }
  )
})
