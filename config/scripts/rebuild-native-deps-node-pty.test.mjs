import { existsSync, readFileSync } from 'node:fs'
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
  writeFakeNodePtyConptySource,
  writeFakeUsableElectronPackage,
  writeFakeWindowsProcessTree,
  writeFakeWindowsProcessTreeWithNodeAddonApi,
  writeFakeWindowsRegistry,
  writeFakeWindowsSecurity,
  writeNodePtyPatchFile,
  writePatchedNodePtyBuildArtifacts,
  writeWindowsProcessTreePatchFile
} from './rebuild-native-deps-test-fixtures.mjs'

describe('rebuild-native-deps patched node-pty rebuild', () => {
  it.skipIf(process.platform !== 'win32')(
    'passes the Windows tracking default and explicit overrides to forced Electron rebuilds',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir)
        writeFakeWindowsProcessTree(projectDir)
        writeFakeWindowsSecurity(projectDir)
        writeFakeNodePtyConptyPayload(projectDir, process.arch)

        const env = {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath,
          npm_config_platform: 'win32',
          npm_config_arch: process.arch
        }
        for (const override of [
          {},
          { TrackFileAccess: 'true' },
          { trackfileaccess: 'true' },
          { tRaCkFiLeAcCeSs: 'false' }
        ]) {
          const result = runRebuildScript(projectDir, { ...env, ...override })
          expect(result.status, result.stderr).toBe(0)
        }

        const calls = readFileSync(rebuildLogPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(calls.map((call) => call.trackFileAccess)).toEqual([
          'false',
          'true',
          'true',
          'false'
        ])
        expect(calls.every((call) => call.force)).toBe(true)
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
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { nativeDir: '../build/Release/' })
        writeFakeWindowsRegistry(projectDir)
        writeFakeWindowsProcessTree(projectDir)
        writeFakeWindowsSecurity(projectDir)
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

  const commandLineSourcePath = (projectDir) =>
    join(
      projectDir,
      'node_modules',
      '@vscode',
      'windows-process-tree',
      'src',
      'process_commandline.cc'
    )

  // Run inside a worktree: git apply prefixes cwd paths and can silently skip mismatches with exit 0; TEMP-only fixture misses production failure.
  // Cover autocrlf true/false: upstream source is CRLF, patch LF; repair blinds Git to repo config, leaving host-dependent global/system defaults.
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
        expect(readFileSync(commandLineSourcePath(projectDir), 'utf8')).toContain(
          'kProcessCommandLineInformation'
        )
      } finally {
        removeTreeSync(projectDir)
      }
    })
  }

  // Refuse stale reader before build: it compiles but opens each process with PROCESS_VM_READ to walk its PEB, the primitive the patch removes.
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

  it('refuses a Windows rebuild when the process creation-time patch is missing', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir)
      writeFakeNodePtyConptyPayload(projectDir, 'x64')
      writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir, { creationTimePatchApplied: false })

      const result = runRebuildScript(
        projectDir,
        { npm_config_platform: 'win32', npm_config_arch: 'x64' },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('process creation-time patch')
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
        writeFakeWindowsSecurity(projectDir)
        writeFakeNodePtyConptyPayload(projectDir, process.arch)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath,
          npm_config_platform: 'win32',
          npm_config_arch: process.arch
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('Rebuilding failed native modules: @orca/windows-registry')
        const rebuildCall = JSON.parse(readFileSync(rebuildLogPath, 'utf8').trim())
        expect(rebuildCall.onlyModules).toEqual(['@orca/windows-registry'])
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
        writeFakeWindowsSecurity(projectDir)
        writeFakeNodePtyConptyPayload(projectDir, process.arch)

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

  // Model loadable addon with all job exports but no MSYS denial: require/export checks pass while Git Bash children leak.
  it.skipIf(process.platform !== 'win32')(
    'rebuilds a loadable ConPTY native that owns its job but predates the MSYS breakaway denial',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeLoadableNodePty(projectDir, { cygwinBreakawayDenied: false })
        writeFakeWindowsRegistry(projectDir)
        writeFakeWindowsProcessTree(projectDir)
        writeFakeWindowsSecurity(projectDir)
        writeFakeNodePtyConptyPayload(projectDir, process.arch)
        writeFakeNodePtyConptySource(projectDir)

        const result = runRebuildScript(projectDir, {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath,
          npm_config_platform: 'win32',
          npm_config_arch: process.arch
        })

        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('Rebuilding failed native modules: node-pty')
        expect(result.stdout).toContain('predates the Cygwin/MSYS job-breakaway denial')
        expect(result.stdout).not.toContain('skipping rebuild')
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

  // Check rebuilt artifact destined for packaged app; neither relay gate nor runtime load check covers it. Missing output after success must fail too.
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

  // Always inspect binary: Electron probe may be skipped; job exports predate MSYS denial and cannot detect escaped Git Bash children.
  it('fails a Windows rebuild that leaves an addon predating the MSYS breakaway denial', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir)
      writeFakeNodePtyConptyPayload(projectDir, 'x64', { cygwinBreakawayDenied: false })
      writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)

      const result = runRebuildScript(
        projectDir,
        { npm_config_platform: 'win32', npm_config_arch: 'x64' },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('predates the Cygwin/MSYS job-breakaway denial')
    } finally {
      removeTreeSync(projectDir)
    }
  })

  // Check source before compile: stale install rebuilds byte-identical unsafe addon, then wrongly advises repeating rebuild.
  it('refuses to compile node-pty source that lacks the denial, before the rebuild runs', () => {
    const projectDir = mkTempProject()

    try {
      const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
      writeFakeNodePtyConptyPayload(projectDir, 'x64')
      writeFakeNodePtyConptySource(projectDir, { cygwinBreakawayDenied: false })
      writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)

      const result = runRebuildScript(
        projectDir,
        {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath,
          npm_config_platform: 'win32',
          npm_config_arch: 'x64'
        },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(join('src', 'win', 'conpty.cc'))
      expect(result.stderr).toContain('`pnpm install`')
      expect(result.stderr).not.toContain('Rebuild node-pty from source')
      expect(existsSync(rebuildLogPath)).toBe(false)
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('calls the rebuild API when node-pty source carries the denial', () => {
    const projectDir = mkTempProject()

    try {
      const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
      writeFakeNodePtyConptyPayload(projectDir, 'x64')
      writeFakeNodePtyConptySource(projectDir)
      writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)

      const result = runRebuildScript(
        projectDir,
        {
          ORCA_REBUILD_TEST_LOG: rebuildLogPath,
          npm_config_platform: 'win32',
          npm_config_arch: 'x64'
        },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status, result.stderr).toBe(0)
      const rebuildCall = JSON.parse(readFileSync(rebuildLogPath, 'utf8').trim())
      expect(rebuildCall.onlyModules).toContain('node-pty')
    } finally {
      removeTreeSync(projectDir)
    }
  })

  it('accepts a Windows rebuild whose addon carries the denial', () => {
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
      expect(result.stderr).not.toContain('job-breakaway denial')
    } finally {
      removeTreeSync(projectDir)
    }
  })

  // Cross-host rebuild or absent optional node-pty may leave no win32 addon; warn without breaking a working install.
  it('warns rather than fails when no addon is expected on this disk', () => {
    const projectDir = mkTempProject()

    try {
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir)
      writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)

      const result = runRebuildScript(
        projectDir,
        { npm_config_platform: 'win32', npm_config_arch: 'x64' },
        ['--platform=win32', '--arch=x64', '--force']
      )

      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr + result.stdout).toContain('could not check the MSYS job-breakaway')
    } finally {
      removeTreeSync(projectDir)
    }
  })

  // Same-host missing output must fail: loader falls back to upstream prebuild that leaks MSYS children. Only Windows can exercise this branch.
  it.skipIf(process.platform !== 'win32')(
    'fails a same-host Windows rebuild that left no addon, naming the prebuild that would load',
    () => {
      const projectDir = mkTempProject()

      try {
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir)
        writeFakeWindowsProcessTreeWithNodeAddonApi(projectDir)
        writeFakeLoadableNodePty(projectDir, { nativeDir: `prebuilds/win32-${process.arch}` })

        const result = runRebuildScript(
          projectDir,
          { npm_config_platform: 'win32', npm_config_arch: process.arch },
          ['--platform=win32', `--arch=${process.arch}`, '--force']
        )

        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(join('build', 'Release', 'conpty.node'))
        expect(result.stderr).toContain(join('prebuilds', `win32-${process.arch}`, 'conpty.node'))
      } finally {
        removeTreeSync(projectDir)
      }
    }
  )
})
