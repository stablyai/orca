import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

export const PR_BROWSER_E2E_SOURCE_ROUTES = [
  {
    id: 'browser.image-link-native-focus',
    specs: ['tests/e2e/browser-image-link-focus.spec.ts'],
    matches: (file) =>
      file ===
        'src/renderer/src/components/browser-pane/assemble-chrome/browser-page-guest-focus.ts' ||
      file === 'tests/e2e/helpers/browser-link-server.ts'
  },
  {
    // Client-rendered host rows need two real Electron apps; omit high-churn ipc/runtime/useIpcEvents/preload seams covered by main-process integration.
    id: 'client-hosted-browser.host-strip',
    specs: ['tests/e2e/paired-client-hosted-browser-host-strip.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/.*(?:[Cc]lient-?[Hh]osted-?[Bb]rowser|BrowserPaneOverlayLayer)/.test(file)
  },
  {
    // Restart survival also depends on adoption, lease/reconciliation and tab snapshots; include orca-runtime.ts despite churn because it publishes the hold flag.
    id: 'client-hosted-browser.restart-survival',
    specs: ['tests/e2e/paired-client-hosted-browser-restart-survival.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      (file === 'src/main/runtime/browser/browser-commands.ts' ||
        /^src\/.*(?:[Cc]lient-?[Hh]osted|browser-host-(?:lease|page|client-page)|browser-client-(?:host|page)|runtime-browser-(?:client-)?page|session-tabs-sync|host-session-snapshot-authority|orca-runtime\.ts|\/runtime-(?:status|types)\.ts)/.test(
          file
        ))
  }
]
