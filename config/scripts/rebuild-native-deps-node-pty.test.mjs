import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  gitLineEndingEnv,
  initGitWorkTree,
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
  writePatchedNodePtyBuildArtifacts,
  writeWindowsProcessTreePatchFile
} from './rebuild-native-deps-test-fixtures.mjs'

describe('rebuild-native-deps patched node-pty rebuild', () => {
  it.skipIf(process.platform !== 'win32')(
    'rebuilds a loadable identity addon that still imports ReadProcessMemory without --force',
    () => {
      const projectDir = mkTempProject()
      try {
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { nativeDir: '../build/Release/' })
        writeFakeNodePtyConptyPayload(projectDir, process.arch)
        writeFakeWindowsRegistry(projectDir)
        writeFakeWindowsProcessTree(projectDir)
        const addonPath = join(
          projectDir,
          'node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node'
        )
        appendFileSync(addonPath, 'ReadProcessMemory')
        const logPath = join(projectDir, 'electron-rebuild.log')
        const result = runRebuildScript(projectDir, {
          npm_config_platform: 'win32',
          npm_config_arch: process.arch,
          ORCA_REBUILD_TEST_LOG: logPath
        })
        expect(result.status, result.stderr).toBe(0)
        const calls = readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(calls).toHaveLength(1)
        expect(calls[0].onlyModules).toEqual(['@vscode/windows-process-tree'])
        expect(readFileSync(addonPath).includes('ReadProcessMemory')).toBe(false)
      } finally {
        removeTreeSync(projectDir)
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'repairs a missing ConPTY runtime before probing without recompiling node-pty',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, {
          logPathEnv: 'ORCA_REBUILD_TEST_LOG'
        })
        writeFakeLoadableNodePty(projectDir, {
          nativeDir: '../build/Release/'
        })
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

  it('stages windows-process-tree outside pnpm and excludes it from the other Electron rebuild', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir, {
        logPathEnv: 'ORCA_REBUILD_TEST_LOG'
      })
      writeFakeNodePtyConptyPayload(projectDir, 'x64')
      writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)

      const result = runRebuildScript(
        projectDir,
        {
          npm_config_platform: 'win32',
          npm_config_arch: 'x64',
          ORCA_REBUILD_TEST_LOG: join(projectDir, 'electron-rebuild.log')
        },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status, result.stderr).toBe(0)
      const calls = readFileSync(join(projectDir, 'electron-rebuild.log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(calls).toHaveLength(2)
      expect(calls[0].buildPath).not.toContain(projectDir)
      expect(calls[0].projectRootPath).toBe(calls[0].buildPath)
      expect(calls[0].buildFromSource).toBe(true)
      expect(calls[0].onlyModules).toEqual(['@vscode/windows-process-tree'])
      expect(calls[1].onlyModules).not.toContain('@vscode/windows-process-tree')
      expect(existsSync(join(projectDir, 'node_modules/@vscode/windows-process-tree/deps'))).toBe(
        false
      )
    } finally {
      removeTreeSync(projectDir)
    }
  })

  const commandLineSourcePath = (projectDir) =>
    join(
      projectDir,
      'node_modules',
      '@vscode',
      'windows-process-tree',
      'src',
      'process_commandline.cc'
    )

  // Why inside a git work tree: `git apply` run under one prefixes patch paths
  // with the cwd-relative prefix, silently skips what does not match, and still
  // exits 0. The package dir is always under the project root in production, so
  // a fixture in %TEMP% alone would pass while the real repair did nothing.
  //
  // Why both line-ending modes: the patch is stored LF while upstream ships this
  // source CRLF, so whether the pre-image matches depends on `core.autocrlf` --
  // and under `false`, Git's own built-in default, it did not. The repair blinds
  // git to the repo, so that value comes from global config, i.e. from whichever
  // option the developer's installer wrote. Pinning both makes the case cover the
  // host that breaks rather than the host that happens to run it.
  for (const autocrlf of ['false', 'true']) {
    it(`repairs an un-applied command-line patch in a work tree (autocrlf=${autocrlf})`, () => {
      const projectDir = mkTempProject()

      try {
        initGitWorkTree(projectDir)
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir)
        writeFakeNodePtyConptyPayload(projectDir, 'x64')
        writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir, {
          commandLinePatchApplied: false
        })
        writeWindowsProcessTreePatchFile(projectDir)

        const result = runRebuildScript(
          projectDir,
          {
            npm_config_platform: 'win32',
            npm_config_arch: 'x64',
            ...gitLineEndingEnv(autocrlf)
          },
          ['--platform=win32', '--arch=x64', '--force']
        )

        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(commandLineSourcePath(projectDir), 'utf8')).not.toContain(
          'kProcessCommandLineInformation'
        )
      } finally {
        removeTreeSync(projectDir)
      }
    })
  }

  // Why fail rather than build: an unpatched command-line reader compiles fine
  // and then opens every process with PROCESS_VM_READ to walk its PEB, which is
  // the primitive the patch exists to remove.
  it('refuses a Windows rebuild when the command-line patch cannot be applied', () => {
    const projectDir = mkTempProject()

    try {
      initGitWorkTree(projectDir)
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir)
      writeFakeNodePtyConptyPayload(projectDir, 'x64')
      writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir, { commandLinePatchApplied: false })
      // No patch file, so the repair has nothing to apply.

      const result = runRebuildScript(
        projectDir,
        { npm_config_platform: 'win32', npm_config_arch: 'x64' },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('process_commandline.cc')
      expect(readFileSync(commandLineSourcePath(projectDir), 'utf8')).not.toContain(
        'kProcessCommandLineInformation'
      )
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
        writeFakeElectronRebuild(projectDir, {
          logPathEnv: 'ORCA_REBUILD_TEST_LOG'
        })
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
        writeFakeElectronRebuild(projectDir, {
          logPathEnv: 'ORCA_REBUILD_TEST_LOG'
        })
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
        writeFakeElectronRebuild(projectDir, {
          logPathEnv: 'ORCA_REBUILD_TEST_LOG'
        })
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
        writeFakeElectronRebuild(projectDir, {
          logPathEnv: 'ORCA_REBUILD_TEST_LOG'
        })
        writeFakeLoadableNodePty(projectDir, {
          nativeDir: '../build/Release/'
        })
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
        writeFakeElectronRebuild(projectDir, {
          logPathEnv: 'ORCA_REBUILD_TEST_LOG'
        })
        writeFakeLoadableNodePty(projectDir, {
          nativeDir: '../prebuilds/darwin-arm64/'
        })
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

  // The binary this step produces is the one copied into the packaged app. The
  // relay build checks its own artifact and ensure-native-runtime checks what it
  // loads; nothing checked this one, so a rebuild that quietly emitted the
  // upstream reader shipped. Both non-clean states have to fail, which is the
  // caller the tri-state was missing: after a rebuild that reported success, an
  // absent binary is a broken build, not an absence to shrug at.
  for (const [addon, expected] of [
    ['unpatched', 'still imports ReadProcessMemory'],
    ['none', 'is not there']
  ]) {
    it(`fails a Windows rebuild that leaves ${addon} windows-process-tree bytes`, () => {
      const projectDir = mkTempProject()

      try {
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { addon })
        writeFakeNodePtyConptyPayload(projectDir, 'x64')
        writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)

        const result = runRebuildScript(
          projectDir,
          { npm_config_platform: 'win32', npm_config_arch: 'x64' },
          ['--platform=win32', '--arch=x64', '--force']
        )

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(expected)
      } finally {
        removeTreeSync(projectDir)
      }
    })
  }
})
