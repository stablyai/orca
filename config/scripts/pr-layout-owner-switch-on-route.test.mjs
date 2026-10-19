import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import { MANAGED_SSH_E2E_SPEC_PREFIX, selectGeneralE2eSpecs } from './ci-e2e-job-selection.mjs'
import { divergenceKind, summarizeDivergence } from './layout-save-divergence-summary.mjs'
import {
  isLayoutOwnerSwitchOnSource,
  LAYOUT_OWNER_SWITCH_ON_E2E_SPECS
} from './pr-layout-owner-switch-on-route.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const read = (file) => parse(readFileSync(join(projectDir, file), 'utf8'))
const prWorkflow = read('.github/workflows/pr.yml')
const e2eWorkflow = read('.github/workflows/e2e.yml')

describe('layout owner switch-on job', () => {
  const job = prWorkflow.jobs.layout_owner_switch_on

  it('runs the listed specs on a switch-on build of the merge commit', () => {
    expect(job.uses).toBe('./.github/workflows/e2e.yml')
    expect(job.with.ref).toBe('${{ github.sha }}')
    expect(job.with.layout_owner).toBe('main')
    expect(JSON.parse(job.with.test_files)).toEqual(LAYOUT_OWNER_SWITCH_ON_E2E_SPECS)
    for (const spec of LAYOUT_OWNER_SWITCH_ON_E2E_SPECS) {
      if (spec !== MANAGED_SSH_E2E_SPEC_PREFIX) {
        expect(existsSync(join(projectDir, spec)), spec).toBe(true)
      }
    }
    // Every spec that gates on the switch-on build marker runs here.
    const gated = readdirSync(join(projectDir, 'tests/e2e'))
      .filter((file) => file.endsWith('.spec.ts'))
      .map((file) => `tests/e2e/${file}`)
      .filter((spec) =>
        readFileSync(join(projectDir, spec), 'utf8').includes('ORCA_LAYOUT_OWNER_MAIN')
      )
    expect(gated.length).toBeGreaterThan(0)
    expect(LAYOUT_OWNER_SWITCH_ON_E2E_SPECS).toEqual(expect.arrayContaining(gated))
    expect(selectGeneralE2eSpecs(LAYOUT_OWNER_SWITCH_ON_E2E_SPECS)).not.toContain(
      'tests/e2e/workspace-layout-oracle-headless.spec.ts'
    )
  })

  it('does not block the merge and keeps its artifacts apart', () => {
    expect(prWorkflow.jobs.verify.needs).not.toContain('layout_owner_switch_on')
    const suffixes = Object.values(prWorkflow.jobs)
      .filter((other) => other.uses === './.github/workflows/e2e.yml')
      .map((other) => other.with.artifact_suffix ?? '')
    expect(new Set(suffixes).size).toBe(suffixes.length)
  })

  it('sets the switch only on the app builds, never job-wide', () => {
    for (const other of Object.values(e2eWorkflow.jobs)) {
      expect(JSON.stringify(other.env ?? {})).not.toContain('layout_owner')
    }
    const build = e2eWorkflow.jobs.build.steps.find((step) => step.name === 'Build E2E outputs')
    expect(build.run).toContain('export ORCA_LAYOUT_OWNER="$LAYOUT_OWNER"')
    expect(e2eWorkflow.on.workflow_call.inputs.layout_owner.default).toBe('')
  })

  it('routes layout sources, the e2e tree and the job itself', () => {
    for (const file of [
      'src/shared/workspace-layout/workspace-layout-load.ts',
      'src/shared/layout-owner-switch.ts',
      'src/main/persistence/window-save-divergence.ts',
      'src/main/runtime/terminal-surface-close.ts',
      'src/renderer/src/store/slices/terminals.ts',
      'tests/e2e/helpers/orca-app.ts',
      '.github/workflows/pr.yml',
      '.github/workflows/e2e.yml'
    ]) {
      expect(isLayoutOwnerSwitchOnSource(file), file).toBe(true)
    }
    for (const file of ['src/renderer/src/components/ui/button.tsx', 'docs/STYLEGUIDE.md']) {
      expect(isLayoutOwnerSwitchOnSource(file), file).toBe(false)
    }
    const filter = prWorkflow.jobs.code_paths.steps.find((step) => step.id === 'e2e_filter')
    expect(filter.run).toContain('node config/scripts/pr-layout-owner-switch-on-route.mjs')
    expect(prWorkflow.jobs.code_paths.steps[0].with['sparse-checkout']).toContain(
      '/config/scripts/pr-layout-owner-switch-on-route.mjs'
    )
  })
})

describe('layout save divergence summary', () => {
  it('counts reports by kind and by the spec running when each was written', () => {
    const id = 'c47bcbc2-ec0c-458b-9d54-a2252e8f747a'
    const report = {
      suites: [
        {
          file: 'a.spec.ts',
          specs: [
            {
              line: 8,
              title: 'opens',
              tests: [{ results: [{ startTime: '2026-10-19T00:00:00.000Z', duration: 1000 }] }]
            }
          ]
        }
      ]
    }
    const start = Date.parse('2026-10-19T00:00:00.000Z')
    const lines = [
      JSON.stringify({
        at: start + 500,
        paths: [`group ${id} changed: tabOrder`, 'workspace added']
      }),
      // Written after the test ended, as delayed saves are.
      JSON.stringify({ at: start + 5000, paths: [`terminal ${id} tab-bar entry removed`] }),
      JSON.stringify({ at: start + 60_000, paths: ['1 pane(s) rebound'] }),
      '{"at":',
      ''
    ]
    expect(summarizeDivergence(lines, [report])).toEqual({
      reports: 3,
      paths: 4,
      unreadable: 1,
      byKind: {
        'group <id> changed: tabOrder': 1,
        'workspace added': 1,
        'terminal <id> tab-bar entry removed': 1,
        '<n> pane(s) rebound': 1
      },
      bySpec: { 'a.spec.ts:8 opens': 2, unattributed: 1 },
      bySpecAndKind: {
        'a.spec.ts:8 opens': {
          'group <id> changed: tabOrder': 1,
          'workspace added': 1,
          'terminal <id> tab-bar entry removed': 1
        },
        unattributed: { '<n> pane(s) rebound': 1 }
      }
    })
    expect(divergenceKind('tab picker-agent-tab changed: createdAt, terminal')).toBe(
      'tab <id> changed: createdAt, terminal'
    )
    expect(divergenceKind('editor view /tmp/a b/c.ts changed: viewState')).toBe(
      'editor view <id> changed: viewState'
    )
    expect(divergenceKind('file /tmp/a b/c.ts added')).toBe('file <id> added')
  })
})
