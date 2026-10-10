import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '@orca/process-host'
import {
  classifyE2eJobs,
  DEDICATED_E2E_SPECS,
  DOCKER_SSH_E2E_SPECS,
  LOCALHOST_SSH_E2E_SPEC,
  NATIVE_IME_E2E_SPEC,
  NODE_NETWORK_E2E_SPEC,
  selectGeneralE2eSpecs
} from './ci-e2e-job-selection.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'

it.each([
  'src/main/runtime/runtime-browser-commands-factory.ts',
  'src/main/runtime/orca-runtime-get-status.ts',
  'src/main/orcad/orcad-browser-startup.ts'
])('routes the managed browser capability oracle from %s', (path) => {
  expect(selectPrE2eSpecs([path])).toContain('tests/e2e/ssh-orcad-browser-capabilities.spec.ts')
})

it.each(['errors', 'status', 'lifecycle', 'restart-attempt'])(
  'routes the real browser service status check from %s changes',
  (name) => {
    expect(
      selectPrE2eSpecs([
        `src/renderer/src/components/browser-pane/stream-remote/remote-browser-stream-${name}.ts`
      ])
    ).toContain('tests/e2e/ssh-orcad-browser-service-status.spec.ts')
  }
)

it.each([
  'src/renderer/src/lib/ssh-workspace-browser-route-eligibility.ts',
  'src/renderer/src/components/browser-pane/use-ssh-workspace-browser-route.ts',
  'src/main/browser/local-ssh-browser-route.ts',
  'src/renderer/src/store/repos/converted-ssh-browser-pages.ts',
  'src/renderer/src/store/slices/browser/browser-tab-actions.ts',
  'src/renderer/src/hooks/ipc-events/ssh-managed-server-state-effects.ts'
])('routes the managed browser routing oracle from %s', (path) => {
  expect(selectPrE2eSpecs([path])).toContain('tests/e2e/ssh-orcad-browser-routing.spec.ts')
})

const workflow = parse(readFileSync('.github/workflows/e2e.yml', 'utf8'))
const prWorkflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const classify = (specs, ssh = 'false') => classifyE2eJobs(JSON.stringify(specs), ssh)

it('runs real browser file-drop ownership in the template-building Docker job', () => {
  const spec = 'tests/e2e/ssh-orcad-browser-drop-owner.spec.ts'
  expect(classify([spec])).toEqual({ e2e_run_changed: false, e2e_needs_build: true })
  const job = workflow.jobs['orcad-auto-convert-docker']
  expect(job.if).toContain(spec)
  expect(
    job.steps.some((step) => step.run?.includes(spec) && step.env?.ORCA_E2E_SSH_DOCKER === '1')
  ).toBe(true)
  for (const source of [
    'src/renderer/src/lib/file-preview.ts',
    'src/renderer/src/lib/workspace-file-drag.ts',
    'src/renderer/src/components/browser-pane/navigate/use-browser-page-navigation-downloads.ts',
    'src/renderer/src/components/right-sidebar/FileExplorerRow.tsx',
    'tests/e2e/helpers/browser-split-guest-probes.ts'
  ]) {
    expect(selectPrE2eSpecs([source]), source).toContain(spec)
  }
})

it('skips the general consumer only when every requested spec has a dedicated owner', () => {
  for (const spec of DEDICATED_E2E_SPECS) {
    expect(classify([spec]).e2e_run_changed, spec).toBe(false)
  }
  expect(classify(DEDICATED_E2E_SPECS).e2e_run_changed).toBe(false)
  const future = 'tests/e2e/future-unclassified.spec.ts'
  expect(classify([future])).toEqual({
    e2e_run_changed: true,
    e2e_needs_build: true
  })
  expect(selectGeneralE2eSpecs([...DEDICATED_E2E_SPECS, future])).toEqual([future])
  expect(classify([...DEDICATED_E2E_SPECS, future]).e2e_run_changed).toBe(true)
})

it('keeps Electron build and native prerequisites for every consumer requiring them', () => {
  for (const spec of [...DOCKER_SSH_E2E_SPECS, LOCALHOST_SSH_E2E_SPEC]) {
    expect(classify([spec]), spec).toEqual({
      e2e_run_changed: false,
      e2e_needs_build: true
    })
  }
  for (const spec of [NODE_NETWORK_E2E_SPEC, NATIVE_IME_E2E_SPEC]) {
    expect(classify([spec]), spec).toEqual({
      e2e_run_changed: false,
      e2e_needs_build: false
    })
    expect(classify([spec], 'true').e2e_needs_build).toBe(true)
  }
  expect(workflow.jobs['ssh-browser-network-route'].needs).toBeUndefined()
  for (const name of ['e2e', 'changed-e2e', 'ssh-docker-watcher-isolation', 'ssh-localhost']) {
    expect(workflow.jobs[name].needs, name).toEqual(['build', 'prepare-native-cache'])
  }
})

it('retains allocations when selection or SSH evidence is incomplete', () => {
  for (const input of ['', '[]', 'null', '{}', '[null]', '[""]', 'malformed']) {
    expect(classifyE2eJobs(input), input).toEqual({
      e2e_run_changed: true,
      e2e_needs_build: true
    })
  }
  expect(classify([NODE_NETWORK_E2E_SPEC], '').e2e_needs_build).toBe(true)
})

it('preserves the requested specs across source-routed and mixed selections', () => {
  for (const files of [
    ['src/main/ssh/connection.ts'],
    ['src/main/browser/ssh-browser-network-execution-route.ts'],
    ['src/main/agent-hooks/server.ts'],
    ['src/shared/terminal-unicode-provider.ts'],
    ['tests/e2e/ssh-localhost.spec.ts', 'tests/e2e/future-unclassified.spec.ts']
  ]) {
    const specs = selectPrE2eSpecs(files)
    const general = selectGeneralE2eSpecs(specs)
    const dedicated = specs.filter((spec) => DEDICATED_E2E_SPECS.includes(spec))
    expect([...general, ...dedicated].sort(), files.join(', ')).toEqual(specs)
    expect(new Set([...general, ...dedicated]).size).toBe(specs.length)
  }
})

it('applies allocation hints only to PRs and retains other callers and full references', () => {
  for (const name of ['run_changed_e2e', 'needs_build']) {
    expect(workflow.on.workflow_call.inputs[name]).toMatchObject({
      type: 'boolean',
      required: false,
      default: true
    })
  }
  for (const name of ['build', 'prepare-native-cache']) {
    expect(workflow.jobs[name].if).toBe(
      "inputs.test_files == '' || github.event_name != 'pull_request' || inputs.needs_build"
    )
  }
  expect(workflow.jobs.e2e.if).toBe("inputs.test_files == ''")
  const changed = workflow.jobs['changed-e2e']
  expect(changed.if).toContain("github.event_name != 'pull_request' || inputs.run_changed_e2e")
  const command = changed.steps.find((step) => step.name === 'Run changed E2E specs').run
  expect(command).toContain('node config/scripts/ci-e2e-job-selection.mjs >')
  expect(command).not.toContain('mapfile -t TEST_FILES < <(')
  const fallback = [...command.matchAll(/\. != "([^"]+)"/g)].map((match) => match[1])
  expect(fallback).toEqual(DEDICATED_E2E_SPECS)
})

it('publishes conservative hints for malformed evidence and refuses a malformed consumer list', async () => {
  const program = 'config/scripts/ci-e2e-job-selection.mjs'
  const consumer = await runProcess({
    program: process.execPath,
    args: [program],
    input: 'malformed',
    timeoutMs: 10000
  })
  expect(consumer.code).not.toBe(0)
  const hints = await runProcess({
    program: process.execPath,
    args: [program, '--job-outputs'],
    input: 'malformed',
    timeoutMs: 10000
  })
  expect(hints.code, hints.stderr).toBe(0)
  expect(hints.stdout).toBe('e2e_run_changed=true\ne2e_needs_build=true\n')
})

it('classifies PR consumers in the existing detector and passes conservative allocation hints', () => {
  const detector = prWorkflow.jobs.code_paths
  expect(detector.steps[0].with['sparse-checkout']).toContain(
    '/config/scripts/ci-e2e-job-selection.mjs'
  )
  for (const name of ['e2e_run_changed', 'e2e_needs_build']) {
    expect(detector.outputs[name]).toBe(`\${{ steps.e2e_filter.outputs.${name} }}`)
  }
  const command = detector.steps.find((step) => step.id === 'e2e_filter').run
  expect(command).toContain('E2E_SSH_SOURCE_CHANGED="$SSH_SOURCE_CHANGED"')
  expect(command).toContain('ci-e2e-job-selection.mjs --job-outputs >> "$GITHUB_OUTPUT"')
  expect(prWorkflow.jobs.e2e.with.run_changed_e2e).toBe(
    "${{ needs.code_paths.outputs.e2e_run_changed != 'false' }}"
  )
  expect(prWorkflow.jobs.e2e.with.needs_build).toBe(
    "${{ needs.code_paths.outputs.e2e_needs_build != 'false' }}"
  )
})

it('runs remaining SSH tests after real failures and stops them when a run is cancelled', () => {
  const steps = workflow.jobs['ssh-docker-watcher-isolation'].steps
  expect(steps.find((step) => step.name === 'Run remaining Docker SSH E2E').if).toBe('!cancelled()')
  expect(
    steps.find((step) => step.name === 'Run Docker SSH terminal parking + startup readiness E2E').if
  ).toBe('!cancelled() && matrix.shard == 1')
  for (const step of steps.filter((step) => step.name?.startsWith('Keep '))) {
    expect(step.if).toContain('always()')
  }
})

it.each([
  'src/renderer/src/runtime/web-session-tabs-sync/mirrored-editor-file-identity.ts',
  'src/renderer/src/runtime/web-session-tabs-sync/tab-builders.ts',
  'src/renderer/src/runtime/web-session-tabs-sync/apply-preparation-browser.ts',
  'src/renderer/src/runtime/web-session-existing-tab-index.ts'
])('routes %s to the template-building editor ownership lane', (file) => {
  const spec = 'tests/e2e/ssh-orcad-editor-ownership.spec.ts'
  expect(selectPrE2eSpecs([file])).toContain(spec)
  expect(classify([spec])).toEqual({
    e2e_run_changed: false,
    e2e_needs_build: true
  })
  const job = workflow.jobs['orcad-auto-convert-docker']
  expect(job.if).toContain(spec)
  expect(job.steps.find((step) => step.name === 'Convert a relay-era Docker host').run).toContain(
    spec
  )
})

const MARKDOWN_CONVERSION_SPEC = 'tests/e2e/ssh-orcad-markdown-conversion.spec.ts'
const MARKDOWN_LINK_REFRESH_SPEC = 'tests/e2e/ssh-orcad-markdown-link-refresh.spec.ts'
const MARKDOWN_LIVE_DOCUMENTS_SPEC = 'tests/e2e/ssh-orcad-markdown-live-documents.spec.ts'

it.each([
  ['src/renderer/src/components/editor/useMarkdownDocuments.ts', MARKDOWN_CONVERSION_SPEC],
  [
    'src/renderer/src/components/editor/restored-editor-workspace-runtime-owner.ts',
    MARKDOWN_CONVERSION_SPEC
  ],
  [
    'src/renderer/src/components/editor/migrate-restored-editor-file-owner.ts',
    MARKDOWN_CONVERSION_SPEC
  ],
  ['src/renderer/src/components/editor/rich-markdown-doc-link.ts', MARKDOWN_LINK_REFRESH_SPEC],
  [
    'src/renderer/src/components/editor/useRichMarkdownProgrammaticSync.ts',
    MARKDOWN_LINK_REFRESH_SPEC
  ],
  ['src/renderer/src/components/editor/useMarkdownDocuments.ts', MARKDOWN_LIVE_DOCUMENTS_SPEC],
  [
    'src/renderer/src/components/editor/use-markdown-document-watch-refresh.ts',
    MARKDOWN_LIVE_DOCUMENTS_SPEC
  ],
  [
    'src/renderer/src/components/editor/markdown-document-list-request.ts',
    MARKDOWN_LIVE_DOCUMENTS_SPEC
  ]
])('routes %s to the template-building Markdown lane %s', (file, spec) => {
  expect(selectPrE2eSpecs([file])).toContain(spec)
  expect(classify([spec])).toEqual({
    e2e_run_changed: false,
    e2e_needs_build: true
  })
  const job = workflow.jobs['orcad-auto-convert-docker']
  expect(job.if).toContain(spec)
  expect(job.steps.find((step) => step.name === 'Convert a relay-era Docker host').run).toContain(
    spec
  )
})

it.each([
  'src/renderer/src/hooks/useEditorExternalWatch.ts',
  'src/renderer/src/hooks/editor-runtime-file-watch.ts'
])('routes %s to the template-building editor watch recovery lane', (file) => {
  const spec = 'tests/e2e/ssh-orcad-editor-watch-recovery.spec.ts'
  expect(selectPrE2eSpecs([file])).toContain(spec)
  expect(classify([spec])).toEqual({ e2e_run_changed: false, e2e_needs_build: true })
  const job = workflow.jobs['orcad-auto-convert-docker']
  expect(job.if).toContain(spec)
  expect(job.steps.find((step) => step.name === 'Convert a relay-era Docker host').run).toContain(
    spec
  )
})

it.each([
  'src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts',
  'src/renderer/src/hooks/worktree-file-change-event.ts'
])('routes %s to the template-building explorer watch recovery lane', (file) => {
  const spec = 'tests/e2e/ssh-orcad-explorer-watch-recovery.spec.ts'
  expect(selectPrE2eSpecs([file])).toContain(spec)
  expect(classify([spec])).toEqual({ e2e_run_changed: false, e2e_needs_build: true })
  const job = workflow.jobs['orcad-auto-convert-docker']
  expect(job.if).toContain(spec)
  expect(job.steps.find((step) => step.name === 'Convert a relay-era Docker host').run).toContain(
    spec
  )
})

it.each([
  'src/renderer/src/components/right-sidebar/useFileExplorerWatch.ts',
  'src/renderer/src/components/right-sidebar/file-explorer-operation-owner.ts',
  'src/renderer/src/components/right-sidebar/FileExplorer.tsx',
  'src/renderer/src/hooks/editor-external-watch-targets.ts',
  'src/renderer/src/components/right-sidebar/useFileExplorerTree.ts',
  'src/renderer/src/components/right-sidebar/use-file-explorer-tree-load-effects.ts'
])('routes %s to the template-building selected-host explorer lane', (file) => {
  const spec = 'tests/e2e/ssh-orcad-explorer-selected-host.spec.ts'
  expect(selectPrE2eSpecs([file])).toContain(spec)
  expect(classify([spec])).toEqual({ e2e_run_changed: false, e2e_needs_build: true })
  const job = workflow.jobs['orcad-auto-convert-docker']
  expect(job.if).toContain(spec)
  expect(job.steps.find((step) => step.name === 'Convert a relay-era Docker host').run).toContain(
    spec
  )
})

it('runs managed terminal root ownership in the Docker conversion lane', () => {
  const spec = 'tests/e2e/ssh-orcad-terminal-root-owner.spec.ts'
  expect(classify([spec])).toEqual({ e2e_run_changed: false, e2e_needs_build: true })
  const lane = workflow.jobs['orcad-auto-convert-docker']
  expect(lane.if).toContain(spec)
  expect(
    lane.steps.some((step) => step.run?.includes(spec) && step.env?.ORCA_E2E_SSH_DOCKER === '1')
  ).toBe(true)
  for (const source of [
    'src/renderer/src/components/terminal-pane/terminal-worktree-path-link.ts',
    'src/renderer/src/components/terminal-pane/terminal-file-open-routing.ts',
    'src/renderer/src/components/terminal-pane/terminal-file-link-actions.ts',
    'src/renderer/src/components/terminal-pane/terminal-file-link-hit-testing.ts',
    'src/renderer/src/components/terminal-pane/terminal-link-handlers.ts',
    'src/renderer/src/lib/worktree-owner-route.ts',
    'tests/e2e/helpers/terminal-workspace-root-link.ts'
  ]) {
    expect(selectPrE2eSpecs([source]), source).toContain(spec)
  }
})
