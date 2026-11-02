import { existsSync, readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflows = {
  windows: parse(
    readFileSync(
      new URL('../../.github/workflows/win-orcad-serve-switch-e2e.yml', import.meta.url),
      'utf8'
    )
  ),
  wsl: parse(
    readFileSync(new URL('../../.github/workflows/wsl-orcad-e2e.yml', import.meta.url), 'utf8')
  ),
  computer: parse(
    readFileSync(new URL('../../.github/workflows/computer-e2e.yml', import.meta.url), 'utf8')
  ),
  hostileHosts: parse(
    readFileSync(new URL('../../.github/workflows/ssh-hostile-hosts.yml', import.meta.url), 'utf8')
  ),
  windowsHosts: parse(
    readFileSync(new URL('../../.github/workflows/ssh-windows-hosts.yml', import.meta.url), 'utf8')
  )
}

function workflowIncludes(paths, files) {
  return files.some((file) =>
    paths.reduce((included, pattern) => {
      const excluded = pattern.startsWith('!')
      return matchesGlob(file, excluded ? pattern.slice(1) : pattern) ? !excluded : included
    }, false)
  )
}

const cases = {
  windows: {
    excluded: [
      'src/main/daemon/daemon-server.test.ts',
      'src/main/orcad/orcad-native-preflight.test.ts',
      'src/main/orcad/nested/orcad-launch.test.ts',
      'src/cli/runtime/serve.test.ts',
      'src/cli/runtime/nested/serve.test.ts'
    ],
    retained: [
      'src/main/daemon/daemon-entry.ts',
      'src/main/daemon/daemon-init-dependency-mocks.ts',
      'src/main/orcad/main.ts',
      'src/main/orcad/launcher.ts',
      'src/main/orcad/orcad-node-slot-fixture.ts',
      'src/main/orcad/orcad.test-fixture.ts',
      'src/main/orcad/__fixtures__/fake-orcad-electron-sidecar.cjs',
      'src/main/orcad/orcad.test.json',
      'src/cli/runtime/serve.ts',
      'src/cli/runtime/serve-test-harness.ts',
      'src/shared/orcad-local-serve-selection.ts',
      'tests/tools/win-update-e2e/serve-switch.mjs',
      '.github/workflows/win-orcad-serve-switch-e2e.yml'
    ],
    product: 'src/main/orcad/main.ts'
  },
  wsl: {
    excluded: [
      'src/main/wsl/wsl-orcad-deploy.test.ts',
      'src/main/wsl/nested/wsl-orcad-deploy.test.ts',
      'src/main/ssh/orcad-activation-outcome-log.test.ts',
      'src/main/managed-server/install/orcad-remote-shell-commands.integration.test.ts'
    ],
    retained: [
      'src/main/wsl/wsl-orcad-real-distro-lane.test.ts',
      'src/main/wsl/wsl-orcad-deploy.ts',
      'src/main/wsl/wsl-orcad-bridge-test-child.ts',
      'src/main/wsl/wsl-orcad.test-fixture.ts',
      'src/main/wsl/wsl-orcad.test.json',
      'src/main/managed-server/install/orcad-remote-launch.ts',
      'src/main/ssh/orcad-launch-test-harness.ts',
      'src/main/ssh/orcad-launch.test-fixture.ts',
      'src/main/managed-server/install/remote-install-transport.ts',
      '.github/workflows/wsl-orcad-e2e.yml'
    ],
    product: 'src/main/wsl/wsl-orcad-deploy.ts'
  }
}

for (const [lane, { excluded, retained, product }] of Object.entries(cases)) {
  describe(`${lane} Orcad E2E change routing`, () => {
    const workflow = workflows[lane]
    const paths = workflow.on.pull_request.paths

    it.each(excluded)('omits a changed or deleted unit root: %s', (file) => {
      expect(workflowIncludes(paths, [file])).toBe(false)
      expect(workflowIncludes(paths, [file, 'docs/ci.md'])).toBe(false)
      expect(workflowIncludes(paths, [file, product])).toBe(true)
      // A rename retains both names, including its product source or destination.
      expect(workflowIncludes(paths, [file, file.replace('.test.ts', '.ts')])).toBe(true)
      expect(workflowIncludes(paths, [file.replace('.test.ts', '.ts'), file])).toBe(true)
    })

    it.each(retained)('retains a changed or deleted lane input: %s', (file) => {
      expect(workflowIncludes(paths, [file])).toBe(true)
    })

    it('keeps explicit manual runs available', () => {
      expect(workflow.on).toHaveProperty('workflow_dispatch')
    })
  })
}

describe.each(['windows', 'computer'])('%s unit-support routing', (lane) => {
  const paths = workflows[lane].on.pull_request.paths
  const helpers = [
    'src/main/daemon/serialize-grid-roundtrip.ts',
    'src/main/daemon/mock-descendant-sweep.ts',
    'src/main/daemon/daemon-host-relocation.test-fixture.ts',
    'src/main/daemon/daemon-endpoint-reachability-test-harness.ts'
  ]
  const product = 'src/main/daemon/daemon-entry.ts'
  const renamed = 'src/main/daemon/serialize-grid-runtime.ts'

  it.each(helpers)('leaves known unit support to its suites: %s', (helper) => {
    expect(workflowIncludes(paths, [helper])).toBe(false)
    expect(workflowIncludes(paths, [helper, 'docs/ci.md'])).toBe(false)
    expect(workflowIncludes(paths, [helper, product])).toBe(true)
    // Both names of a rename must retain the production workflow.
    expect(workflowIncludes(paths, [helper, renamed])).toBe(true)
    expect(workflowIncludes(paths, [renamed, helper])).toBe(true)
    expect(workflowIncludes(paths, ['src/main/daemon/unknown-test-harness.ts'])).toBe(true)
  })

  it('keeps production selected when multiple unit fixtures change', () => {
    expect(workflowIncludes(paths, helpers)).toBe(false)
    expect(workflowIncludes(paths, [...helpers, product])).toBe(true)
  })
})

it.each([
  'config/scripts/daemon-boot-smoke.mjs',
  'config/scripts/daemon-endpoint-handover-smoke.mjs',
  'config/scripts/windows-daemon-workspace-close-repro.mjs',
  'config/scripts/computer-use-smoke.test.mjs',
  'src/main/providers/windows-shell-preflight-runtime.windows.test.ts',
  'native/computer-use-macos/Sources/OrcaComputerUseMacOS/main.swift',
  'src/cli/handlers/computer.ts',
  '.github/workflows/computer-e2e.yml'
])('keeps the computer contract owner selected: %s', (file) => {
  expect(workflowIncludes(workflows.computer.on.pull_request.paths, [file])).toBe(true)
})

it('re-includes the real WSL distro root after excluding unit tests', () => {
  const paths = workflows.wsl.on.pull_request.paths
  const exclude = paths.indexOf('!src/main/wsl/**/*.test.ts')
  expect(exclude).toBeGreaterThan(paths.indexOf('src/main/wsl/**'))
  expect(paths.indexOf('src/main/wsl/wsl-orcad-real-distro-lane.test.ts')).toBeGreaterThan(exclude)
  const steps = workflows.wsl.jobs.wsl2.steps
  const phases = steps.filter((step) => step.env?.ORCA_RUN_WSL_ORCAD_LANE === '1')
  expect(phases.map((step) => step.env.ORCA_WSL_ORCAD_LANE_PHASE)).toEqual(['launch', 'survive'])
  for (const phase of phases) {
    expect(phase.run).toContain('src/main/wsl/wsl-orcad-real-distro-lane.test.ts')
  }
})

// Each remote host lane executes these sources, so a change to one must start the lane.
describe.each([
  ['hostileHosts', ['src/main/ssh/ssh-connection.ts', 'src/main/ssh/ssh-connection-utils.ts']],
  ['windowsHosts', ['src/main/ssh/ssh-connection.ts', 'src/main/ssh/ssh-connection-utils.ts']],
  ['wsl', ['src/main/orcad/orcad-wsl-host-login-environment.ts']]
])('%s remote transport routing', (lane, sources) => {
  const paths = workflows[lane].on.pull_request.paths

  it.each(sources)('starts the lane for %s', (file) => {
    expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true)
    expect(workflowIncludes(paths, [file])).toBe(true)
    expect(workflowIncludes(paths, [file.replace(/\.ts$/, '.test.ts')])).toBe(false)
  })
})
