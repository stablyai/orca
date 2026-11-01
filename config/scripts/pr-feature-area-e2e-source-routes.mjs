import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

const COMPONENTS = 'src/renderer/src/components/'

/** A route for product sources under any of `prefixes` to specs that only exercise that feature. */
function featureRoute(id, specs, prefixes) {
  return {
    id,
    specs: specs.map((name) => `tests/e2e/${name}.spec.ts`),
    matches: (file) => isProductSource(file) && prefixes.some((prefix) => file.startsWith(prefix))
  }
}

// Feature areas whose specs the nightly suite alone used to select (gap audit, Oct 2026).
export const PR_FEATURE_AREA_E2E_SOURCE_ROUTES = [
  featureRoute(
    'feature.automations-ui',
    ['automation-prompt-disclosure', 'automation-runs-dashboard'],
    [`${COMPONENTS}automations/`]
  ),
  featureRoute('feature.feature-wall', ['feature-wall'], [`${COMPONENTS}feature-wall/`]),
  featureRoute(
    'feature.sparse-checkout',
    ['sparse-explorer-proof', 'sparse-preset-proof'],
    [`${COMPONENTS}sparse/`]
  ),
  featureRoute(
    'feature.onboarding',
    ['onboarding', 'onboarding-language-catalog-retry'],
    [`${COMPONENTS}onboarding/`]
  ),
  featureRoute(
    'feature.diff-notes',
    [
      'diff-note-delete',
      'diff-note-draft',
      'diff-note-edit',
      'diff-note-layout',
      'diff-note-line-range'
    ],
    [`${COMPONENTS}diff-comments/`]
  ),
  featureRoute(
    'feature.floating-terminal',
    [
      'floating-terminal-switch-reveal',
      'floating-terminal-tab-rename-focus',
      'floating-workspace-pane-height'
    ],
    [`${COMPONENTS}floating-terminal/`]
  ),
  featureRoute(
    'feature.dictation',
    ['dictation-indicator', 'voice-microphone-selection'],
    [`${COMPONENTS}dictation/`, 'src/main/speech/']
  ),
  featureRoute(
    'feature.ai-vault',
    ['ai-vault-panel-search', 'ai-vault-session-delete'],
    [
      'src/main/ai-vault/',
      'src/main/ai-vault-search/',
      `${COMPONENTS}right-sidebar/ai-vault-`,
      `${COMPONENTS}right-sidebar/AiVault`
    ]
  ),
  featureRoute(
    'feature.linear',
    [
      'linear-filter-chip-labels',
      'linear-issue-view-persistence',
      'linear-private-images',
      'linear-url-workspace-entry'
    ],
    [
      `${COMPONENTS}task-page/linear/`,
      'src/renderer/src/store/slices/linear/',
      'src/main/linear/',
      'src/main/ipc/linear/',
      'src/shared/linear/'
    ]
  ),
  featureRoute(
    'feature.jira',
    ['jira-panel-layout'],
    [`${COMPONENTS}task-page/jira/`, 'src/main/jira/', 'src/main/ipc/jira/', 'src/shared/jira/']
  ),
  featureRoute('feature.tasks-page', ['tasks-page'], [`${COMPONENTS}task-page/`]),
  featureRoute(
    'feature.project-groups',
    ['project-group-creation-visibility', 'project-group-manual-sort'],
    ['src/main/project-groups/', 'src/renderer/src/store/project-groups/']
  ),
  featureRoute('feature.usage-overview', ['usage-overview'], [`${COMPONENTS}stats/`]),
  featureRoute('feature.pet', ['pet-status-segment-layout'], [`${COMPONENTS}pet/`]),
  featureRoute('feature.setup-guide', ['setup-guide-sidebar'], [`${COMPONENTS}setup-guide/`]),
  featureRoute(
    'feature.new-workspace',
    [
      'new-workspace-create-more',
      'new-workspace-cross-project-dialog',
      'new-workspace-linked-item-project-switch'
    ],
    [`${COMPONENTS}new-workspace/`]
  )
]
