import { existsSync, readFileSync } from 'node:fs'
import { removeTreeSync } from '../../../../src/shared/windows-transient-lock-removal.ts'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  gitLineEndingEnv,
  initGitWorkTree,
  mkTempProject,
  runRebuildScript,
  writeFakeElectronRebuild,
  writeFakeNodePtyConptyPayload,
  writeFakeNodePtyConptySource,
  writeFakeUsableElectronPackage,
  writeFakeWindowsProcessTreeWithNodeAddonApi,
  writeWindowsProcessTreePatchFile
} from './rebuild-native-deps-test-fixtures.mjs'

describe('rebuild-native-deps patched node-pty rebuild', () => {
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

  // Model loadable addon with all job exports but no MSYS denial: require/export checks pass while Git Bash children leak.

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

  // Cross-host rebuild or absent optional node-pty may leave no win32 addon; warn without breaking a working install.

  // Same-host missing output must fail: loader falls back to upstream prebuild that leaks MSYS children. Only Windows can exercise this branch.
})
