import { describe, expect, it } from 'vitest'
import {
  hasNativeImeSourceChange,
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs
} from './pr-e2e-source-routing.mjs'
/** The route that sends a change to the two-Electron restart-survival spec. */
const restartSurvivalRoute = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'client-hosted-browser.restart-survival'
)

describe('restart-survival E2E routing', () => {
  // Keep restart-survival routing narrow to avoid two-Electron cost on every source change.
  it.each([
    'src/main/git/git-status.ts',
    'src/renderer/src/components/tab-bar/BrowserTab.tsx',
    'src/main/terminal/pty-manager.ts',
    // The status/types entries name whole files, not a suffix any longer name may end with.
    'src/shared/computer-use-runtime-types.ts',
    'src/main/runtime/browser/browser-commands.test.ts',
    'src/main/runtime/browser/browser-commands.test-fixture.ts',
    'src/main/runtime/browser/browser-commands.fixture.ts',
    'src/main/runtime/browser/browser-commands-extra.ts',
    'src/main/runtime/browser/commands/browser-navigation.ts'
  ])('does not route %s', (path) => {
    expect(restartSurvivalRoute.matches(path)).toBe(false)
  })
})

describe('paired HTML preview E2E routing', () => {
  const spec = 'tests/e2e/paired-remote-html-preview-local-render.spec.ts'
  it.each([
    'src/renderer/src/components/browser-pane/workspace-doc/doc-preview-external-link-confirmation.tsx',
    'src/renderer/src/components/browser-pane/workspace-doc/HtmlDocPreview.tsx',
    'src/main/browser/document-preview/doc-preview-protocol.ts',
    'src/main/ipc/doc-preview-grant-ipc.ts',
    'src/preload/doc-preview-link-interception.ts',
    'src/shared/doc-preview-scheme.ts',
    'tests/e2e/helpers/paired-html-preview-inventory.ts'
  ])('routes %s', (path) => {
    expect(selectPrE2eSpecs([path])).toContain(spec)
  })
  it.each([
    'src/main/ipc/doc-preview-grant-ipc.test.ts',
    'src/renderer/src/components/browser-pane/BrowserPane.tsx'
  ])('does not route %s', (path) => {
    expect(selectPrE2eSpecs([path])).not.toContain(spec)
  })
})

describe('preview address-bar convergence E2E routing', () => {
  const spec = 'tests/e2e/paired-preview-address-bar-convergence.spec.ts'
  it.each([
    'src/renderer/src/components/browser-pane/workspace-doc/doc-preview-address-edit.tsx',
    'src/renderer/src/components/browser-pane/assemble-chrome/browser-address-bar-suggestions.ts',
    'src/renderer/src/lib/workspace-doc-address-input.ts',
    'src/renderer/src/store/slices/browser/browser-page-conversion-actions.ts'
  ])('routes %s', (path) => {
    expect(selectPrE2eSpecs([path])).toContain(spec)
  })
  it.each([
    'src/renderer/src/store/slices/browser-page-conversion.test.ts',
    'src/renderer/src/components/browser-pane/assemble-chrome/BrowserAddressBar.tsx'
  ])('does not route %s', (path) => {
    expect(selectPrE2eSpecs([path])).not.toContain(spec)
  })
})

describe('PR E2E gate contract', () => {
  it('routes only core xterm patches to both IME lanes across version updates', () => {
    for (const file of [
      'config/patches/@xterm__xterm@6.1.0-beta.336.patch',
      'config/patches/xterm-src/@xterm__xterm@6.1.0-beta.336.src.patch',
      'config/patches/@xterm__xterm@7.0.0.patch',
      'config/patches/xterm-src/@xterm__xterm@7.0.0.src.patch'
    ]) {
      const specs = selectPrE2eSpecs([file])
      expect(hasNativeImeSourceChange([file]), file).toBe(true)
      expect(specs, file).toContain('tests/e2e/terminal-ime-exact-byte.spec.ts')
      expect(specs, file).toContain('tests/e2e/terminal-ibus-hangul-native.spec.ts')
    }
    for (const file of [
      'config/patches/i18next-cli@1.74.2.patch',
      'config/patches/node-pty@1.1.0.patch',
      'config/patches/monaco-editor@0.55.1.patch',
      'config/patches/@xterm__addon-webgl@0.20.0-beta.329.patch',
      'config/patches/xterm-src/@xterm__addon-search@0.17.0-beta.330.src.patch',
      'config/patches/xterm-upstream.json',
      'config/patches/@xterm__xterm@7.0.0.patch.bak'
    ]) {
      expect(hasNativeImeSourceChange([file]), file).toBe(false)
      expect(selectPrE2eSpecs([file]), file).toEqual([])
    }
    const corePatch = 'config/patches/@xterm__xterm@6.1.0-beta.336.patch'
    const mixedChanges = ['config/patches/i18next-cli@1.74.2.patch', corePatch]
    expect(hasNativeImeSourceChange(mixedChanges)).toBe(true)
    expect(selectPrE2eSpecs(mixedChanges)).toEqual(selectPrE2eSpecs([corePatch]))
  })
})

describe('GitHub Projects E2E routing', () => {
  it.each([
    'src/renderer/src/components/github-project/columns.ts',
    'src/renderer/src/store/github/project-field-mutations.ts',
    'src/main/github/project-view/project-field-mutations.ts',
    'src/main/ipc/source-control/github-project-view-handlers.ts'
  ])('routes %s to the board spec', (file) => {
    expect(selectPrE2eSpecs([file])).toContain('tests/e2e/github-project-board.spec.ts')
  })
  it('skips the board spec for unit tests and unrelated GitHub stores', () => {
    for (const file of [
      'src/renderer/src/store/github/project-field-mutations.test.ts',
      'src/renderer/src/store/github/cache-model.ts'
    ]) {
      expect(selectPrE2eSpecs([file]), file).not.toContain('tests/e2e/github-project-board.spec.ts')
    }
  })
})

describe('Terminal pane geometry E2E routing', () => {
  const specs = [
    'tests/e2e/issue-12656-terminal-link-tooltip.spec.ts',
    'tests/e2e/terminal-pane-padding-edges.spec.ts'
  ]
  it.each([
    'src/renderer/src/assets/terminal.css',
    'src/renderer/src/lib/pane-manager/pane-divider.ts',
    'src/renderer/src/lib/pane-manager/pane-dom-creation.ts',
    'src/renderer/src/lib/pane-manager/terminal-linkifier-hover-reset-on-mouseleave.ts'
  ])('routes %s to the pane geometry specs', (file) => {
    expect(selectPrE2eSpecs([file])).toEqual(expect.arrayContaining(specs))
  })
  it('skips the pane geometry specs for their unit tests', () => {
    const selected = selectPrE2eSpecs(['src/renderer/src/lib/pane-manager/pane-divider.test.ts'])
    expect(selected).not.toContain(specs[0])
  })
})

describe('Daemon mock modified-only source routing', () => {
  const helper = 'src/main/daemon/providers/lifecycle/testing/daemon-init-dependency-mocks.ts'
  const verified = { allowDaemonInitTestSupport: true }
  it('omits the real D7 route only for the proven unit-support scope', () => {
    expect(selectPrE2eSpecs([helper])).toContain('tests/e2e/orcad-serve-mode-switch.spec.ts')
    expect(selectPrE2eSpecs([helper], undefined, verified)).toEqual([])
    const companion =
      'config/scripts/desktop-distribution/runtime-verification/process-host-build-dist.test.mjs'
    expect(selectPrE2eSpecs([helper, companion], undefined, verified)).toEqual(
      selectPrE2eSpecs([companion])
    )
  })
  it.each([
    { files: [] },
    { files: [helper, 'src/main/daemon/daemon-init.ts'] },
    { files: [helper, 'package.json'] },
    { files: [helper, 'src/main/daemon/unknown-support.ts'] },
    { files: [helper, helper] }
  ])('retains existing routes for an uncertain or mixed vector $files', ({ files }) => {
    expect(selectPrE2eSpecs(files, undefined, verified)).toEqual(selectPrE2eSpecs(files))
  })
})

describe('runtime host status E2E routing', () => {
  const spec = 'tests/e2e/runtime-host-status-recovery.spec.ts'
  it.each([
    'src/shared/remote-runtime/host-store/runtime-environment-pairing-replace-guards.ts',
    'src/main/ipc/runtime-environments/runtime-environment-status-probe.ts',
    'src/renderer/src/store/slices/runtime-status-refresh.ts'
  ])('routes %s', (path) => {
    expect(selectPrE2eSpecs([path])).toContain(spec)
  })
  it('does not route unit tests of those sources', () => {
    expect(
      selectPrE2eSpecs(['src/renderer/src/store/slices/runtime-status-refresh.test.ts'])
    ).not.toContain(spec)
  })
})

describe('startup exec readiness E2E routing', () => {
  const spec = 'tests/e2e/paired-startup-exec-readiness.spec.ts'
  it.each([
    'src/main/daemon/sessions/session-shell-ready-barrier.ts',
    'src/main/daemon/shell-readiness/post-ready-flush-gate.ts',
    'src/main/pty/shell-startup/shell-templates.ts',
    'tests/e2e/helpers/startup-exec-readiness-oracle.ts'
  ])('routes %s', (path) => {
    expect(selectPrE2eSpecs([path])).toContain(spec)
  })
  it('does not route unit tests of those sources', () => {
    expect(
      selectPrE2eSpecs(['src/main/daemon/shell-readiness/testing/shell-ready.test.ts'])
    ).not.toContain(spec)
  })
})

describe('agent descendant kill E2E routing', () => {
  const spec = 'tests/e2e/agent-descendant-process-kill.spec.ts'
  it.each([
    'src/main/pty/process-retirement/pty-descendant-termination.ts',
    'src/main/daemon/sessions/terminal-descendant-shutdown.ts',
    'src/main/claude/agent-view/agent-view-service.ts'
  ])('routes %s', (file) => {
    expect(selectPrE2eSpecs([file])).toContain(spec)
  })
  it('skips unit tests', () => {
    expect(
      selectPrE2eSpecs(['src/main/pty/process-retirement/pty-descendant-termination.test.ts'])
    ).not.toContain(spec)
  })
})

describe('agent permission settings E2E routing', () => {
  const spec = 'tests/e2e/agent-auto-permissions.spec.ts'
  it.each([
    'src/renderer/src/components/agent/launch-settings/AgentPermissionChoiceControls.tsx',
    'src/renderer/src/components/settings/agents/permissions/AgentPermissionModeMenu.tsx',
    'src/shared/agent-launch/permissions/tui-agent-permission-choice.ts'
  ])('routes %s', (file) => {
    expect(selectPrE2eSpecs([file])).toContain(spec)
  })
  it('skips unit tests', () => {
    expect(
      selectPrE2eSpecs(['src/shared/agent-launch/permissions/tui-agent-permission-choice.test.ts'])
    ).not.toContain(spec)
  })
})
