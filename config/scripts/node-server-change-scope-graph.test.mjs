import { beforeAll, describe, expect, it } from 'vitest'
import {
  classifyNodeServerChanges,
  collectNodeServerInputs,
  discoverNodeServerTests
} from './node-server-change-scope.mjs'
import { nodeServerTestPaths } from './node-server-test-paths.mjs'
import { ORCAD_CHILD_ENTRY_POINTS } from './orcad-entry-build.mjs'

describe('the actual Bun build and profile-test dependency graph', () => {
  let inputs
  beforeAll(async () => {
    inputs = await collectNodeServerInputs()
  }, 60_000)

  it('tracks the shared close probe without pulling in its mocked renderer adapter', () => {
    expect(inputs.has('src/shared/pty-running-work-probe.ts')).toBe(true)
    expect(inputs.has('src/shared/pty-running-work-probe.test.ts')).toBe(true)
    expect(inputs.has('src/renderer/src/components/terminal/pty-running-work-probe.ts')).toBe(false)
    expect(inputs.has('src/renderer/src/runtime/runtime-terminal-inspection.ts')).toBe(false)
    expect([...inputs].filter((file) => file.startsWith('src/renderer/')).sort()).toEqual([
      'src/renderer/src/components/terminal-pane/agent-completion-hook-observer.ts',
      'src/renderer/src/components/terminal-pane/agent-completion-hook-only-observer.ts',
      'src/renderer/src/components/terminal-pane/agent-completion-identity-store.ts',
      'src/renderer/src/components/terminal-pane/agent-completion-notification-controller.ts',
      'src/renderer/src/components/terminal-pane/agent-completion-notification-timestamp.ts',
      'src/renderer/src/hooks/agent-hook-notification-retirement.ts'
    ])
  })

  it.each([
    'config/scripts/ci-shard-timings.json',
    'config/scripts/mobile-web-app/mobile-web-app-terminal-render.test.mjs',
    'src/renderer/src/components/terminal/pty-running-work-probe.ts',
    'src/renderer/src/runtime/runtime-terminal-inspection.ts',
    'src/main/ssh/ssh-relay-upload-stage-commands.test.ts',
    'src/main/persistence/terminal-topology/terminal-topology-boundary-ratchet.test.ts',
    'src/main/menu/register-app-menu.ts'
  ])('skips unrelated work: %s', async (file) => {
    expect((await classifyNodeServerChanges([file], async () => inputs)).shouldRun).toBe(false)
  })

  it.each([
    ...Object.values(ORCAD_CHILD_ENTRY_POINTS),
    'src/renderer/src/components/terminal-pane/agent-completion-hook-observer.ts',
    'src/renderer/src/components/terminal-pane/agent-completion-hook-only-observer.ts',
    'src/renderer/src/components/terminal-pane/agent-completion-identity-store.ts',
    'src/renderer/src/components/terminal-pane/agent-completion-notification-controller.ts',
    'src/renderer/src/components/terminal-pane/agent-completion-notification-timestamp.ts',
    'src/renderer/src/hooks/agent-hook-notification-retirement.ts',
    'src/shared/keybindings/definitions-core-1.ts',
    'src/shared/pty-running-work-probe.ts',
    'src/shared/pty-running-work-probe.test.ts',
    'src/main/runtime/orca-runtime.ts',
    'src/main/windows/windows-process-table.ts',
    'src/main/worker-thread-entry-path.ts',
    'config/scripts/zip-extractor-command.mjs',
    'config/scripts/windows-process-tree-gyp-rebuild.mjs',
    'config/scripts/windows-process-tree-prepared-addon.mjs',
    'config/scripts/orcad-windows-prebuild-cache.mjs',
    'config/scripts/profile-state-worker-smoke.mjs',
    'config/scripts/vitest-host-ports-setup.ts',
    'tests/e2e/daemon-running-work-probe.unit.test.ts'
  ])('retains the full matrix for a real runtime, worker or test input: %s', async (file) => {
    expect(inputs.has(file)).toBe(true)
    expect((await classifyNodeServerChanges([file], async () => inputs)).shouldRun).toBe(true)
  })

  it('retains all selected tests and the selectors the Bun runner uses', () => {
    const tests = discoverNodeServerTests()
    expect(tests.length).toBeGreaterThan(0)
    expect(tests.every((file) => inputs.has(file))).toBe(true)
    expect(
      nodeServerTestPaths().every((selector) => tests.some((file) => file.includes(selector)))
    ).toBe(true)
  })
})
