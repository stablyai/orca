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
    ['automation-prompt-disclosure'],
    [`${COMPONENTS}automations/`]
  ),
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
    'feature.ai-vault',
    ['ai-vault-panel-search', 'ai-vault-session-delete'],
    [
      'src/main/ai-vault/',
      'src/main/ai-vault-search/',
      `${COMPONENTS}right-sidebar/ai-vault/accounts/AiVault`,
      `${COMPONENTS}right-sidebar/ai-vault/accounts/ai-vault-`,
      `${COMPONENTS}right-sidebar/ai-vault/panel/AiVault`,
      `${COMPONENTS}right-sidebar/ai-vault/scanning/AiVault`,
      `${COMPONENTS}right-sidebar/ai-vault/scanning/ai-vault-`,
      `${COMPONENTS}right-sidebar/ai-vault/scope/ai-vault-`,
      `${COMPONENTS}right-sidebar/ai-vault/search/AiVault`,
      `${COMPONENTS}right-sidebar/ai-vault/search/ai-vault-`,
      `${COMPONENTS}right-sidebar/ai-vault/session-actions/ai-vault-`,
      `${COMPONENTS}right-sidebar/ai-vault/session-list/AiVault`,
      `${COMPONENTS}right-sidebar/ai-vault/session-list/ai-vault-`
    ]
  ),
  featureRoute(
    'feature.linear',
    ['linear-issue-view-persistence', 'linear-private-images', 'linear-url-workspace-entry'],
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
  // Pane geometry and the link tooltip share terminal.css and the pane DOM.
  featureRoute(
    'feature.terminal-pane-geometry',
    ['issue-12656-terminal-link-tooltip', 'terminal-pane-padding-edges'],
    [
      'src/renderer/src/assets/terminal.css',
      'src/renderer/src/lib/pane-manager/pane-layout/pane-divider.ts',
      'src/renderer/src/lib/pane-manager/pane-dom-creation.ts',
      'src/renderer/src/lib/pane-manager/terminal-input/terminal-linkifier-hover-reset-on-mouseleave.ts'
    ]
  ),
  featureRoute(
    'feature.github-projects',
    ['github-project-board'],
    [
      `${COMPONENTS}github-project/`,
      'src/renderer/src/store/github/projects/',
      'src/main/github/project-view/',
      'src/main/ipc/source-control/github-project-view-handlers.ts'
    ]
  ),
  featureRoute(
    'feature.agent-descendant-kill',
    ['agent-descendant-process-kill'],
    [
      'src/main/pty/process-retirement/pty-descendant-',
      'src/main/daemon/sessions/terminal-descendant-shutdown.ts',
      'src/main/daemon/terminal-host/terminal-session-teardown.ts',
      'src/main/providers/local-pty/local-pty-termination.ts',
      // Claude launch flags shift the stand-in agent's argv.
      'src/main/claude/agent-view/'
    ]
  ),
  featureRoute(
    'feature.agent-permission-settings',
    ['agent-auto-permissions'],
    [
      `${COMPONENTS}settings/agents/permissions/`,
      `${COMPONENTS}agent/launch-settings/AgentPermission`,
      'src/shared/agent-launch/permissions/tui-agent-permission-choice.ts',
      'src/shared/agent-launch/permissions/tui-agent-permission-lift.ts',
      'src/shared/agent-launch/choices/agent-launch-permission-updates.ts'
    ]
  ),
  featureRoute(
    'feature.project-groups',
    ['project-group-creation-visibility', 'project-group-manual-sort'],
    ['src/main/project-groups/', 'src/renderer/src/store/project-groups/']
  ),
  featureRoute(
    'feature.new-workspace',
    [
      'new-workspace-create-more',
      'new-workspace-cross-project-dialog',
      'new-workspace-linked-item-project-switch'
    ],
    [`${COMPONENTS}new-workspace/`]
  ),
  featureRoute(
    'feature.runtime-host-status',
    ['runtime-host-status-recovery'],
    [
      'src/main/ipc/runtime-environments/runtime-environment-status-',
      'src/renderer/src/store/slices/runtime-status/views/runtime-status-subscriptions.ts',
      'src/renderer/src/store/slices/runtime-status/',
      'src/shared/remote-runtime/host-store/runtime-environment-pairing-replace-guards.ts',
      'src/shared/remote-runtime/host-store/runtime-environment-store.ts',
      `${COMPONENTS}sidebar/workspace-card/identity/worktree-card-header-items.tsx`
    ]
  ),
  featureRoute(
    'feature.startup-exec-readiness',
    ['paired-startup-exec-readiness'],
    [
      'src/main/daemon/sessions/session-shell-ready-barrier.ts',
      'src/main/daemon/shell-readiness/',
      'src/main/pty/shell-startup/shell-prompt-readiness-probe.ts',
      'src/main/pty/shell-startup/shell-startup-output-scanner.ts',
      'src/main/pty/shell-startup/shell-templates.ts',
      'tests/e2e/helpers/startup-exec-readiness-oracle.ts'
    ]
  )
]
