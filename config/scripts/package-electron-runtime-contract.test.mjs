import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')
const readProject = (file) => readFileSync(join(projectDir, file), 'utf8')
const packageJson = JSON.parse(readProject('package.json'))
const pnpmWorkspace = parse(readProject('pnpm-workspace.yaml'))
// Why not process.platform: the win32 plan resolves wherever its os-gated npm addon is
// installed; @orca/windows-registry is a workspace link and present everywhere.
const windowsAddonsInstalled = existsSync(
  join(projectDir, 'node_modules', '@vscode', 'windows-process-tree', 'package.json')
)

describe('Electron runtime package contract', () => {
  const packageTargets = {
    win32: windowsAddonsInstalled ? createPackagedRuntimeNodeModuleResources('win32') : [],
    darwin: createPackagedRuntimeNodeModuleResources('darwin'),
    linux: createPackagedRuntimeNodeModuleResources('linux')
  }

  it('keeps the native Windows registry addon optional and platform-gated', () => {
    expect(packageJson.optionalDependencies['@orca/windows-registry']).toBe('workspace:*')
    // Why: allowBuilds stops pnpm running node-gyp at install time -- the root
    // Windows-only rebuild owns this addon so it is built against the right runtime ABI.
    expect(pnpmWorkspace.allowBuilds['@orca/windows-registry']).toBe(false)
    if (windowsAddonsInstalled) {
      expect(packageTargets.win32).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: join('node_modules', '@orca', 'windows-registry') }),
          expect.objectContaining({ to: join('node_modules', 'node-addon-api') })
        ])
      )
    }
    for (const platform of ['darwin', 'linux']) {
      expect(packageTargets[platform]).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: join('node_modules', '@orca', 'windows-registry') })
        ])
      )
    }
  })

  it('keeps the native Windows process-table addon optional and platform-gated', () => {
    expect(packageJson.optionalDependencies['@vscode/windows-process-tree']).toBe('0.8.0')
    // Why: same rule as the registry addon -- allowBuilds stops pnpm running node-gyp at
    // install time so the Windows-only rebuild owns it with the right runtime ABI.
    expect(pnpmWorkspace.allowBuilds['@vscode/windows-process-tree']).toBe(false)
    // Why pin the patch: the upstream binding.gyp requires Spectre-mitigated
    // libraries our build agents do not carry, and the enumeration stops after
    // 1024 processes -- on a busy host that silently hides the very descendants
    // teardown is looking for.
    expect(pnpmWorkspace.patchedDependencies['@vscode/windows-process-tree@0.8.0']).toBe(
      'config/patches/@vscode__windows-process-tree@0.8.0.patch'
    )
    if (windowsAddonsInstalled) {
      expect(packageTargets.win32).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: join('node_modules', '@vscode', 'windows-process-tree') })
        ])
      )
    }
    for (const platform of ['darwin', 'linux']) {
      expect(packageTargets[platform]).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ to: join('node_modules', '@vscode', 'windows-process-tree') })
        ])
      )
    }
  })

  it('keeps release-cut signing provenance on GitHub-hosted runners', () => {
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const buildMatrixRunners = releaseWorkflow.jobs.build.strategy.matrix.include.map(
      ({ os }) => os
    )
    const releaseWorkflowText = readFileSync(
      join(projectDir, '.github/workflows/release-cut.yml'),
      'utf8'
    )
    const macDispatchStep = releaseWorkflow.jobs['build-mac'].steps.find(
      (step) => step.name === 'Run isolated macOS release build'
    )

    expect(releaseWorkflowText).not.toContain('blacksmith-')
    expect(releaseWorkflow.jobs['build-mac']['runs-on']).toBe('ubuntu-latest')
    expect(releaseWorkflow.jobs['build-mac'].permissions.actions).toBe('write')
    expect(macDispatchStep.run).toBe('node config/scripts/run-release-mac-build-workflow.mjs')
    expect(macDispatchStep.env.RELEASE_MAC_BUILD_WORKFLOW).toBe('release-mac-build.yml')
    expect(macDispatchStep.env.RELEASE_MAC_BUILD_TAG).toBe('${{ needs.cut.outputs.tag }}')
    expect(buildMatrixRunners).not.toContain('blacksmith-6vcpu-macos-15')
    expect(releaseWorkflow.jobs['publish-release'].needs).toContain('build')
    expect(releaseWorkflow.jobs['publish-release'].needs).toContain('build-mac')
  })
})
