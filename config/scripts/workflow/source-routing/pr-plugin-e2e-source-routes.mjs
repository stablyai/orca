import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

const UI = 'src\\/renderer\\/src\\/components\\/plugins\\/'
const STORE = 'src\\/renderer\\/src\\/store\\/plugin-'

/** A route for product sources under `pattern` plus the e2e helpers its specs import. */
function pluginRoute(id, specs, pattern, helpers) {
  return {
    id,
    specs,
    matches: (file) =>
      (helpers !== undefined && helpers.includes(file)) ||
      (isProductSource(file) && new RegExp(`^(?:${pattern})`).test(file))
  }
}

const SPECIFIC_PLUGIN_ROUTES = [
  pluginRoute(
    'plugins.custom-editors-and-new-files',
    ['tests/e2e/plugins/plugin-new-file.spec.ts'],
    [
      `${UI}page\\/PluginContributionActionNewFile`,
      `${STORE}(?:custom-editors|new-files)`,
      'src\\/main\\/plugins\\/contributions\\/plugin-new-file-template',
      'src\\/shared\\/plugins\\/(?:contributions\\/plugin-(?:custom-editor-contribution|new-file-contribution)|frames\\/plugin-custom-editor-bridge)'
    ].join('|'),
    ['tests/e2e/plugins/plugin-frame-guest.ts', 'tests/e2e/plugins/plugin-smoke.ts']
  ),
  // Desktop frames are isolated <webview> guests; a regression here breaks every frame on desktop.
  pluginRoute(
    'plugins.isolated-frames',
    ['tests/e2e/plugins/plugin-isolated-frame.spec.ts'],
    [
      'src\\/main\\/plugins\\/panels\\/(?:frame-serving\\/|guest-isolation\\/|desktop-actions\\/)?plugin-frame-',
      'src\\/shared\\/plugins\\/frames\\/plugin-(?:frame-guest|panel-shell)',
      'src\\/preload\\/plugin-frame-guest',
      'src\\/main\\/window\\/(?:security/(?:main-window-webview-security|host-frame-permission-policy)|attach-main-window-services)',
      'src\\/main\\/ipc\\/(?:plugins|plugin-frame-entry-ipc)\\.ts$',
      'src\\/main\\/startup\\/plugin-startup\\/main-process-plugins',
      'config\\/build-plugins\\/main-build-entry-points',
      'src\\/main\\/browser\\/guest-lifecycle\\/input\\/browser-guest-shortcut-(?:forwarding|dispatch)',
      'src\\/renderer\\/src\\/components\\/(?:plugins\\/frames\\/|right-sidebar\\/plugin-panels\\/PluginPanel\\.tsx$)',
      'src\\/renderer\\/src\\/components\\/editor\\/plugin-editors\\/(?:PluginCustomEditorFrame\\.tsx$|plugin-custom-editor-host)'
    ].join('|'),
    ['tests/e2e/plugins/plugin-frame-guest.ts', 'tests/e2e/plugins/plugin-smoke.ts']
  ),
  pluginRoute(
    'plugins.declarative-panels',
    ['tests/e2e/plugins/plugin-declarative-panel.spec.ts'],
    [
      `${UI}(?:declarative\\/|plugin-icon-glyphs\\.ts$)`,
      'src\\/shared\\/plugins\\/(?:declarative\\/|frames\\/plugin-declarative-)',
      'src\\/renderer\\/src\\/components\\/right-sidebar\\/plugin-panels\\/declarative\\/(?:PluginDeclarativePanel|use-plugin-declarative-|plugin-declarative-)',
      'resources\\/plugins\\/declarative\\/'
    ].join('|'),
    ['tests/e2e/plugins/plugin-frame-guest.ts', 'tests/e2e/plugins/plugin-smoke.ts']
  ),
  // Agents and workspace changes in panels: agents.list, terminal ids on agent events.
  pluginRoute(
    'plugins.panel-agents',
    ['tests/e2e/plugins/plugin-panel-agents.spec.ts'],
    [
      'src\\/main\\/plugins\\/(?:runtime\\/plugin-runtime-binding|events\\/plugin-agent-status-event|workers\\/host-api\\/plugin-workspace-projection)',
      'src\\/shared\\/plugins\\/events\\/plugin-events'
    ].join('|'),
    [
      'tests/e2e/agents/session-fixtures/agent-hook-endpoint.ts',
      'tests/e2e/plugins/plugin-frame-guest.ts',
      'tests/e2e/plugins/plugin-smoke.ts'
    ]
  )
]

export const PR_PLUGIN_E2E_SOURCE_ROUTES = [...SPECIFIC_PLUGIN_ROUTES]
