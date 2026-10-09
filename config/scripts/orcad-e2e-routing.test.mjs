import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  classifyE2eJobs,
  ORCAD_AUTO_CONVERT_E2E_SPEC,
  ORCAD_IDLE_EXIT_E2E_SPEC,
  ORCAD_OPEN_IN_OWNER_E2E_SPEC,
  ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
  WINDOWS_MISSING_APPDATA_E2E_SPEC
} from './ci-e2e-job-selection.mjs'
import { selectPrE2eSpecs, shouldRunReusablePrE2e } from './pr-e2e-source-routing.mjs'

const root = resolve(import.meta.dirname, '../..')
const jobs = parse(readFileSync(resolve(root, '.github/workflows/e2e.yml'), 'utf8')).jobs

function expectRouted(files, spec) {
  for (const file of files) {
    expect(existsSync(resolve(root, file)), file).toBe(true)
    expect(selectPrE2eSpecs([file]), file).toContain(spec)
    expect(shouldRunReusablePrE2e([file]), file).toBe(true)
  }
}

it('routes the mode-switch spec from its serve sources and harness', () => {
  expectRouted(
    [
      'src/main/orcad/orcad-lifecycle.ts',
      'src/main/daemon/daemon-spawner.ts',
      'tests/e2e/helpers/orca-serve-cli-host.ts',
      'tests/e2e/helpers/headless-paired-runtime-host.ts'
    ],
    ORCAD_SERVE_MODE_SWITCH_E2E_SPEC
  )
})

it('routes the missing-AppData spec from its startup sources and harness', () => {
  expectRouted(
    ['src/main/startup/windows-app-data-path.ts', 'tests/e2e/helpers/orca-serve-cli-host.ts'],
    WINDOWS_MISSING_APPDATA_E2E_SPEC
  )
})

it('routes the auto-convert spec from its conversion sources and harness', () => {
  expectRouted(
    [
      'src/main/ssh/orcad-runtime-conversion.ts',
      'tests/e2e/helpers/orcad-convert-flow.ts',
      'tests/e2e/helpers/orcad-convert-host.ts',
      'tests/e2e/helpers/orcad-template-variant.ts',
      'tests/e2e/helpers/orcad-upgrade-profile.ts'
    ],
    ORCAD_AUTO_CONVERT_E2E_SPEC
  )
  expect(selectPrE2eSpecs(['src/main/ssh/orcad-runtime-conversion.test.ts'])).not.toContain(
    ORCAD_AUTO_CONVERT_E2E_SPEC
  )
})

it('routes the idle-exit spec from its idle sources and the shared convert harness', () => {
  expectRouted(
    [
      'src/shared/orcad-idle-exit.ts',
      'src/main/ssh/orcad-remote-runtime-control.ts',
      'tests/e2e/helpers/orcad-convert-flow.ts',
      'tests/e2e/helpers/orcad-convert-host.ts'
    ],
    ORCAD_IDLE_EXIT_E2E_SPEC,
    ORCAD_OPEN_IN_OWNER_E2E_SPEC
  )
})

it('builds the e2e app when only a build-dependent orcad spec is requested', () => {
  for (const spec of [
    ORCAD_SERVE_MODE_SWITCH_E2E_SPEC,
    ORCAD_AUTO_CONVERT_E2E_SPEC,
    ORCAD_IDLE_EXIT_E2E_SPEC,
    ORCAD_OPEN_IN_OWNER_E2E_SPEC
  ]) {
    expect(classifyE2eJobs(JSON.stringify([spec])), spec).toEqual({
      e2e_run_changed: false,
      e2e_needs_build: true
    })
  }
  expect(jobs['orcad-auto-convert-docker'].needs).toEqual(['build', 'prepare-native-cache'])
})

it('runs the auto-convert lane only when routed, not on every SSH source change', () => {
  const condition = jobs['orcad-auto-convert-docker'].if
  for (const spec of [
    ORCAD_AUTO_CONVERT_E2E_SPEC,
    ORCAD_IDLE_EXIT_E2E_SPEC,
    ORCAD_OPEN_IN_OWNER_E2E_SPEC
  ]) {
    expect(condition).toContain(`contains(inputs.test_files, '${spec}')`)
  }
  expect(condition).not.toContain('ssh_source_changed')
})

it('runs both Windows serve specs on one runner, each only when requested', () => {
  expect(jobs['windows-missing-appdata-startup']).toBeUndefined()
  const job = jobs['orcad-serve-mode-switch-windows']
  for (const spec of [ORCAD_SERVE_MODE_SWITCH_E2E_SPEC, WINDOWS_MISSING_APPDATA_E2E_SPEC]) {
    expect(job.if, spec).toContain(`contains(inputs.test_files, '${spec}')`)
    const step = job.steps.find((candidate) => candidate.run?.includes(spec))
    expect(step.if, spec).toContain(`contains(inputs.test_files, '${spec}')`)
    expect(step.env.ORCA_STARTUP_DIAGNOSTICS, spec).toBeUndefined()
  }
})

it('routes managed target-owner guards and menus to the real launch regression', () => {
  expectRouted(
    [
      'src/renderer/src/lib/local-path-open-guard.ts',
      'src/renderer/src/lib/external-editor-open-capability.ts',
      'src/renderer/src/lib/worktree-runtime-owner.ts',
      'src/renderer/src/components/sidebar/WorktreeOpenInMenu.tsx',
      'src/renderer/src/components/sidebar/WorktreeContextMenuView.tsx',
      'src/renderer/src/components/right-sidebar/FileExplorer.tsx',
      'src/renderer/src/components/right-sidebar/FileExplorerToolbar.tsx',
      'src/renderer/src/components/right-sidebar/source-control/listing/entry-context-menu.tsx',
      'tests/e2e/helpers/orcad-convert-flow.ts',
      'tests/e2e/helpers/orcad-convert-host.ts',
      'tests/e2e/helpers/orcad-upgrade-profile.ts',
      'tests/e2e/helpers/docker-ssh-relay-target.ts'
    ],
    ORCAD_OPEN_IN_OWNER_E2E_SPEC
  )
  expect(selectPrE2eSpecs(['src/renderer/src/lib/local-path-open-guard.test.ts'])).not.toContain(
    ORCAD_OPEN_IN_OWNER_E2E_SPEC
  )
  expect(
    jobs['orcad-auto-convert-docker'].steps.some((step) =>
      step.run?.includes(ORCAD_OPEN_IN_OWNER_E2E_SPEC)
    )
  ).toBe(true)
})
