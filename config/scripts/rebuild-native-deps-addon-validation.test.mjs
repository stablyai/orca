import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import {
  gitLineEndingEnv,
  initGitWorkTree,
  mkTempProject,
  runRebuildScript,
  writeFakeElectronRebuild,
  writeFakeUsableElectronPackage,
  writeFakeWindowsProcessTree,
  writeFakeWindowsProcessTreeWithNodeAddonApi,
  writeWindowsProcessTreePatchFile
} from './rebuild-native-deps-test-fixtures.mjs'

describe('rebuild-native-deps addon validation', () => {
  it('stages windows-process-tree node-addon-api headers before a Windows rebuild', () => {
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

  // Why fail rather than build: an unpatched command-line reader compiles fine
  // and then opens every process with PROCESS_VM_READ to walk its PEB, which is
  // the primitive the patch exists to remove.
  it('refuses a Windows rebuild when the command-line patch cannot be applied', () => {
    const projectDir = mkTempProject()

    try {
      initGitWorkTree(projectDir)
      writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
      writeFakeElectronRebuild(projectDir)
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

  it.skipIf(process.platform !== 'win32')(
    'rebuilds only the failing registry while the process-tree addon stays healthy',
    () => {
      const projectDir = mkTempProject()

      try {
        const rebuildLogPath = join(projectDir, 'electron-rebuild.log')
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { logPathEnv: 'ORCA_REBUILD_TEST_LOG' })
        writeFakeWindowsProcessTree(projectDir)

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

  for (const [addon, expected] of [
    ['unpatched', 'still imports ReadProcessMemory'],
    ['none', 'is not there']
  ]) {
    it(`fails a Windows rebuild that leaves ${addon} windows-process-tree bytes`, () => {
      const projectDir = mkTempProject()

      try {
        writeFakeUsableElectronPackage(projectDir, { platform: 'win32' })
        writeFakeElectronRebuild(projectDir, { addon })
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
