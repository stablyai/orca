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
    'src/main/runtime/browser/browser-navigation.ts'
  ])('does not route %s', (path) => {
    expect(restartSurvivalRoute.matches(path)).toBe(false)
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
