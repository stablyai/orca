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
    'plugin-git-fixture|plugin-gleam-catalog-fixture|plugin-smoke'
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
    'plugin-smoke'
  ),
  pluginRoute(
    'plugins.panels-and-workers',
    ['plugin-demo', 'plugin-panel-containment'],
    [
      `${UI}(?:page\\/PluginContributionAction(?:Panel|Command|Events)|state\\/use-plugin-logs)`,
      `${STORE}panels`,
      'src\\/main\\/plugins\\/(?:panels\\/|workers\\/|plugin-(?:command-|event-delivery|agent-status-event|storage-store|secrets-store|log-buffer))',
      'src\\/shared\\/plugins\\/(?:frames\\/|workers\\/|events\\/|capabilities\\/|contributions\\/plugin-(?:command-|event-|panel-|execution-profile))'
    ].join('|'),
    'plugin-panel-navigation-observer'
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
