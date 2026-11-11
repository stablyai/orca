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
    // Paired HTML previews render client-side over orca-preview://; links route through confirmation into the browser.
    id: 'doc-preview.paired-local-render',
    specs: ['tests/e2e/paired-remote-html-preview-local-render.spec.ts'],
    matches: (file) =>
      file === 'tests/e2e/helpers/paired-html-preview-inventory.ts' ||
      (isProductSource(file) &&
        (/^src\/(?:main|preload|renderer\/src|shared)\/.*doc-preview[^/]*\.tsx?$/.test(file) ||
          /^src\/renderer\/src\/components\/browser-pane\/workspace-doc\/[^/]+\.tsx?$/.test(file)))
  },
  {
    // Preview ⇄ web-tab conversion from the address bar, including Back/Forward across it and document suggestions.
    id: 'browser.preview-address-bar-convergence',
    specs: ['tests/e2e/paired-preview-address-bar-convergence.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      /^src\/renderer\/src\/(?:components\/browser-pane\/(?:workspace-doc\/doc-preview-address-edit|navigate\/(?:workspace-doc-address-submission|use-client-hosted-page-url-submission)|assemble-chrome\/browser-address-bar-suggestions)|lib\/(?:workspace-doc-address-input|browser\/history\/browser-page-conversion-history)|store\/slices\/browser\/pages\/(?:browser-page-conversion|browser-page-conversion-actions))\.tsx?$/.test(
        file
      )
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
      (file === 'src/main/runtime/browser/commands/browser-commands.ts' ||
        /^src\/.*(?:[Cc]lient-?[Hh]osted|browser-host-(?:lease|page|client-page)|browser-client-(?:host|page)|runtime-browser-(?:client-)?page|session-tabs-sync|host-session-snapshot-authority|orca-runtime\.ts|\/runtime-(?:status|types)\.ts)/.test(
          file
        ))
  }
]
