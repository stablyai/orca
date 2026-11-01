import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

/** Plugin system sources; every product file here (outside `__mocks__`) routes to a plugin spec. */
export const PLUGIN_SYSTEM_SOURCE =
  /^src\/(?:renderer\/src\/(?:components\/plugins\/|store\/plugin-)|main\/plugins\/|shared\/plugins\/)/

const UI = 'src\\/renderer\\/src\\/components\\/plugins\\/'
const STORE = 'src\\/renderer\\/src\\/store\\/plugin-'

/** A route for product sources under `pattern` plus the e2e helpers its specs import. */
function pluginRoute(id, specs, pattern, helpers) {
  return {
    id,
    specs: specs.map((name) => `tests/e2e/${name}.spec.ts`),
    matches: (file) =>
      (helpers !== undefined &&
        new RegExp(`^tests\\/e2e\\/helpers\\/(?:${helpers})\\.ts$`).test(file)) ||
      (isProductSource(file) && new RegExp(`^(?:${pattern})`).test(file))
  }
}

const SPECIFIC_PLUGIN_ROUTES = [
  // #36218 broke review/list/dialog flows with no plugin spec selected.
  pluginRoute(
    'plugins.update-review',
    ['plugin-update-review', 'plugin-update-review-toast'],
    [
      `${UI}(?:review\\/|list\\/|dialogs\\/Plugin(?:UpdateAll|Remove)Dialog)`,
      `${UI}state\\/use-plugin-(?:review-queue|update-dialog|page-model)`,
      `${UI}presentation\\/plugin-(?:publisher-trust|consent-copy|access-profile|capability-presentation)`,
      `${STORE}(?:update-review-toast|auto-updates)`,
      'src\\/main\\/plugins\\/catalog\\/plugin-(?:auto-updater|update-approval|update-review-notices|release-first-seen-store)',
      'src\\/shared\\/plugins\\/(?:approval\\/|catalog\\/plugin-update-policy|contributions\\/plugin-contribution-summary)'
    ].join('|'),
    'plugin-git-fixture|plugin-update-catalog-fixture'
  ),
  pluginRoute(
    'plugins.catalog-and-page',
    ['plugin-install-link', 'plugin-marketplace-content'],
    [
      `${UI}(?:catalog\\/|list\\/|page\\/|PluginContributionIcon|dialogs\\/Plugin(?:Install|CatalogLink|MarketplaceSource)Dialog)`,
      `${UI}state\\/use-plugin-(?:catalog|install-link|install-action|marketplace-lifecycle|page-navigation|page-model|hover-prefetch|in-use|art-palettes|contribution-source)`,
      `${UI}(?:state\\/plugin-preview-cache|presentation\\/plugin-(?:status-presentation|install-source|release-date|contributions|error-presentation))`,
      `${STORE}content-list-store`,
      'src\\/main\\/plugins\\/(?:installation\\/|catalog\\/plugin-(?:marketplace-|catalog-|one-click-enable|community-marketplace-seed|kill-list-))',
      'src\\/main\\/plugins\\/plugin-(?:list-projection|client-list|image-)',
      'src\\/shared\\/plugins\\/(?:catalog\\/|installation\\/|images\\/|plugin-list-entry|contributions\\/plugin-contribution-(?:summary|points))'
    ].join('|'),
    'plugin-git-fixture|plugin-gleam-catalog-fixture|plugin-language-pack-fixture'
  ),
  pluginRoute(
    'plugins.file-type-suggestion',
    ['plugin-file-type-suggestion'],
    [
      'src\\/renderer\\/src\\/components\\/editor\\/PluginFileTypeSuggestion\\.tsx$',
      `${UI}state\\/use-plugin-settings-writes`,
      'src\\/main\\/plugins\\/catalog\\/plugin-file-type-suggestion',
      'src\\/shared\\/plugins\\/contributions\\/plugin-(?:file-type|file-match|custom-editor-core-file-types)'
    ].join('|'),
    'plugin-git-fixture|plugin-smoke'
  ),
  pluginRoute(
    'plugins.try-it',
    ['plugin-try-it'],
    [
      `${UI}state\\/(?:plugin-try-action|plugin-action-toast|use-plugin-install-action)`,
      `${STORE}preview-request`
    ].join('|'),
    'plugin-git-fixture|plugin-gleam-catalog-fixture|plugin-smoke|plugin-frame-guest'
  ),
  pluginRoute(
    'plugins.themes',
    ['plugin-theme-smoke'],
    [
      `${UI}(?:state\\/plugin-theme-apply|page\\/PluginTheme)`,
      `${STORE}(?:themes|icon-themes|monaco-theme)`,
      'src\\/main\\/plugins\\/contributions\\/plugin-(?:theme-registries|icon-theme-registry|content-pack-registry|artifact-pack-registry)',
      'src\\/shared\\/plugins\\/(?:artifacts\\/plugin-(?:theme|icon-theme|terminal-theme)-artifact|contributions\\/plugin-content-pack-contributions)'
    ].join('|'),
    'plugin-smoke'
  ),
  pluginRoute(
    'plugins.syntax-and-language-packs',
    ['plugin-syntax-smoke', 'plugin-marketplace-content'],
    [
      `${UI}page\\/PluginContributionAction(?:Syntax|Language)`,
      `${STORE}(?:syntax-packs|syntax-failures|language-packs)`,
      'src\\/main\\/plugins\\/contributions\\/plugin-(?:syntax|language-pack)-registry',
      'src\\/shared\\/plugins\\/(?:languages\\/|plugin-language-pack-i18n-resources|artifacts\\/plugin-(?:syntax|language-pack)-artifact)'
    ].join('|'),
    'plugin-smoke|plugin-language-pack-fixture'
  ),
  pluginRoute(
    'plugins.custom-editors-and-new-files',
    ['plugin-custom-editor', 'plugin-new-file'],
    [
      `${UI}page\\/PluginContributionActionNewFile`,
      `${STORE}(?:custom-editors|new-files)`,
      'src\\/main\\/plugins\\/plugin-new-file-template',
      'src\\/shared\\/plugins\\/(?:contributions\\/plugin-(?:custom-editor-contribution|new-file-contribution)|frames\\/plugin-custom-editor-bridge)'
    ].join('|'),
    'plugin-smoke|plugin-frame-guest'
  ),
  pluginRoute(
    'plugins.panels-and-workers',
    ['plugin-demo', 'plugin-panel-containment'],
    [
      `${UI}(?:page\\/PluginContributionAction(?:Panel|Command|Events)|state\\/use-plugin-logs)`,
      `${STORE}panels`,
      'src\\/main\\/plugins\\/(?:panels\\/|workers\\/|plugin-(?:command-|event-delivery|agent-status-event|storage-store|secrets-store|log-buffer))',
      'src\\/shared\\/plugins\\/(?:frames\\/|workers\\/|events\\/|capabilities\\/|contributions\\/plugin-(?:command-|event-|panel-|execution-profile))',
      'examples\\/plugins\\/(?:hello-orca|test-fixtures\\/hostile-panel)\\/'
    ].join('|'),
    'plugin-panel-navigation-observer|plugin-frame-guest'
  ),
  // Desktop frames are isolated <webview> guests; a regression here breaks every frame on desktop.
  pluginRoute(
    'plugins.isolated-frames',
    ['plugin-isolated-frame', 'plugin-panel-containment'],
    [
      'src\\/main\\/plugins\\/panels\\/plugin-frame-',
      'src\\/shared\\/plugins\\/frames\\/plugin-(?:frame-guest|panel-shell)',
      'src\\/preload\\/plugin-frame-guest',
      'src\\/main\\/window\\/(?:main-window-webview-security|attach-main-window-services|host-frame-permission-policy)',
      'src\\/main\\/ipc\\/(?:plugins|plugin-frame-entry-ipc)\\.ts$',
      'src\\/main\\/startup\\/main-process-plugins',
      'config\\/build-plugins\\/main-build-entry-points',
      'src\\/main\\/browser\\/browser-guest-shortcut-(?:forwarding|dispatch)',
      'src\\/renderer\\/src\\/components\\/right-sidebar\\/(?:plugin-frame-|use-plugin-frame-|PluginPanel\\.tsx$|plugin-panel-design-token-css|use-plugin-panel-theme-revision)',
      'src\\/renderer\\/src\\/components\\/editor\\/(?:PluginCustomEditorFrame\\.tsx$|plugin-custom-editor-host)'
    ].join('|'),
    'plugin-frame-guest|plugin-smoke'
  ),
  pluginRoute(
    'plugins.declarative-panels',
    ['plugin-declarative-panel'],
    [
      `${UI}declarative\\/`,
      'src\\/shared\\/plugins\\/(?:declarative\\/|frames\\/plugin-declarative-)',
      'src\\/renderer\\/src\\/components\\/right-sidebar\\/(?:PluginDeclarativePanel|use-plugin-declarative-|plugin-declarative-)',
      'resources\\/plugins\\/declarative\\/'
    ].join('|'),
    'plugin-frame-guest|plugin-smoke'
  ),
  // The component catalog: Orca draws each component, so the gallery exercises every one.
  pluginRoute(
    'plugins.components-catalog',
    ['plugin-components-gallery'],
    [
      `${UI}declarative\\/`,
      'src\\/shared\\/plugins\\/declarative\\/plugin-declarative-(?:catalog|[a-z]+-props|prop-schemas|tree)',
      'resources\\/plugins\\/declarative\\/orca-components',
      'src\\/main\\/plugins\\/panels\\/plugin-panel-image',
      'examples\\/plugins\\/components-gallery\\/'
    ].join('|'),
    'plugin-frame-guest|plugin-smoke'
  ),
  // Build-less TS/TSX: the frame protocol transpiles source modules and resolves their imports.
  pluginRoute(
    'plugins.buildless-tsx',
    ['plugin-buildless-tsx'],
    [
      'src\\/main\\/plugins\\/panels\\/plugin-frame-(?:module-|source-serving|protocol\\.ts$)',
      'src\\/main\\/plugins\\/plugin-content-hash',
      'src\\/shared\\/plugins\\/frames\\/plugin-frame-source-modules',
      'src\\/cli\\/plugin-authoring\\/plugin-(?:type-files|components-template)',
      'examples\\/plugins\\/hello-tsx\\/'
    ].join('|'),
    'plugin-frame-guest|plugin-smoke'
  ),
  // Dev hot reload of components panels: memory atoms carried over, last good tree kept on errors.
  pluginRoute(
    'plugins.components-hot-reload',
    ['plugin-components-hot-reload'],
    [
      'src\\/shared\\/plugins\\/declarative\\/(?:plugin-declarative-message|runtime\\/declarative-(?:atoms|memory-retention|error-location|panel-context|renderer))',
      'src\\/shared\\/plugins\\/frames\\/plugin-(?:declarative-host-document|frame-bridge)',
      'src\\/renderer\\/src\\/components\\/right-sidebar\\/(?:PluginDeclarativePanel|PluginPanel\\.tsx$|use-plugin-declarative-(?:state|tree)|plugin-declarative-retained-memory)',
      'src\\/main\\/plugins\\/(?:plugin-dev-|panels\\/plugin-frame-guest-sessions)',
      'resources\\/plugins\\/declarative\\/'
    ].join('|'),
    'plugin-frame-guest|plugin-smoke'
  ),
  // Agents and workspace changes in panels: agents.list, terminal ids on agent events.
  pluginRoute(
    'plugins.panel-agents',
    ['plugin-panel-agents'],
    [
      'src\\/main\\/plugins\\/(?:plugin-runtime-binding|plugin-agent-status-event|workers\\/plugin-workspace-projection)',
      'src\\/shared\\/plugins\\/events\\/plugin-events'
    ].join('|'),
    'plugin-frame-guest|plugin-smoke|agent-hook-endpoint'
  ),
  // A panel and its own worker: requests, posts, storage, settings and pushes.
  pluginRoute(
    'plugins.worker-panel',
    ['plugin-worker-panel'],
    [
      'src\\/main\\/plugins\\/panels\\/plugin-panel-bridge',
      'src\\/main\\/plugins\\/(?:plugin-declared-settings|workers\\/plugin-(?:worker-orca-api|host-panel-method-bindings|worker-requests))',
      'src\\/main\\/ipc\\/plugin-(?:panel-push|settings)-ipc',
      'src\\/shared\\/plugins\\/(?:workers\\/plugin-panel-bridge-protocol|frames\\/plugin-panel-shell-facades|contributions\\/plugin-settings-)',
      'src\\/shared\\/plugins\\/declarative\\/runtime\\/declarative-(?:data-sdk|storage-sync)',
      'src\\/renderer\\/src\\/components\\/plugins\\/(?:page\\/PluginSettingsSection|state\\/use-plugin-declared-settings)',
      'examples\\/plugins\\/hello-worker-panel\\/'
    ].join('|'),
    'plugin-frame-guest|plugin-smoke'
  ),
  // `orca plugin open` / `shot`: renderer reveal, draw wait and main's capture of the panel rect.
  pluginRoute(
    'plugins.view-shot',
    ['plugin-shot'],
    [
      `${UI}view\\/`,
      `${STORE}view-capture`,
      'src\\/(?:main|shared)\\/plugins\\/view\\/',
      'src\\/main\\/runtime\\/rpc\\/methods\\/plugin-view',
      'src\\/cli\\/(?:handlers|specs)\\/plugin-view',
      'src\\/renderer\\/src\\/hooks\\/(?:ipc-events\\/plugin-view-ipc-bridge|use-document-dark-theme)',
      'src\\/renderer\\/src\\/components\\/right-sidebar\\/(?:plugin-panel-draw-status|use-plugin-panel-draw-report|right-sidebar-panel-content)'
    ].join('|'),
    'plugin-frame-guest|plugin-smoke|compiled-orca-cli'
  ),
  pluginRoute(
    'plugins.vm-recipes',
    ['plugin-marketplace-content'],
    [
      'src\\/main\\/plugins\\/plugin-(?:approved-vm-recipes|vm-recipe-)',
      'src\\/shared\\/plugins\\/artifacts\\/plugin-vm-recipe-artifact'
    ].join('|'),
    'plugin-language-pack-fixture'
  ),
  pluginRoute(
    'plugins.startup-and-manifest',
    ['plugin-startup-budget', 'plugin-demo'],
    [
      'src\\/main\\/plugins\\/plugin-(?:service|discovery|enablement|activation-policy|bundled-bootstrap|refresh-settlement|manifest-|content-|declarative-content-integrity|dev-)',
      'src\\/shared\\/plugins\\/(?:manifest\\/|approval\\/plugin-consent-|plugin-system-settings)'
    ].join('|')
  )
]

export const PR_PLUGIN_E2E_SOURCE_ROUTES = [
  ...SPECIFIC_PLUGIN_ROUTES,
  {
    // New or unlisted plugin sources still run the broadest single plugin journey.
    id: 'plugins.unrouted-source',
    specs: ['tests/e2e/plugin-demo.spec.ts'],
    matches: (file) =>
      isProductSource(file) &&
      PLUGIN_SYSTEM_SOURCE.test(file) &&
      !file.includes('/__mocks__/') &&
      !SPECIFIC_PLUGIN_ROUTES.some((route) => route.matches(file))
  }
]
