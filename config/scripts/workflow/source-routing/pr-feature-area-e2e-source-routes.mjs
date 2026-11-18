import { isUnitTestSupportSource } from './pr-code-change-scope.mjs'

const isProductSource = (file) => !/\.test\.tsx?$/.test(file) && !isUnitTestSupportSource(file)

const COMPONENTS = 'src/renderer/src/components/'

/** A route for product sources under any of `prefixes` to specs that only exercise that feature. */
function featureRoute(id, specs, prefixes) {
  return {
    id,
    specs,
    matches: (file) => isProductSource(file) && prefixes.some((prefix) => file.startsWith(prefix))
  }
}

// Feature areas whose specs the nightly suite alone used to select (gap audit, Oct 2026).
export const PR_FEATURE_AREA_E2E_SOURCE_ROUTES = [
  featureRoute(
    'feature.floating-terminal',
    ['tests/e2e/layout/window-tabs/floating-terminal-tab-rename-focus.spec.ts'],
    [`${COMPONENTS}floating-terminal/`]
  ),
  featureRoute(
    'feature.ai-vault',
    ['tests/e2e/activity/ai-vault-session-delete.spec.ts'],
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
    ['tests/e2e/integrations/linear/linear-url-workspace-entry.spec.ts'],
    [
      `${COMPONENTS}task-page/linear/`,
      'src/renderer/src/store/slices/linear/',
      'src/main/linear/',
      'src/main/ipc/linear/',
      'src/shared/linear/'
    ]
  ),
  featureRoute(
    'feature.agent-descendant-kill',
    ['tests/e2e/agents/session-lifecycle/agent-descendant-process-kill.spec.ts'],
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
    'feature.project-groups',
    ['tests/e2e/workspaces/project-admission/project-group-manual-sort.spec.ts'],
    ['src/main/project-groups/', 'src/renderer/src/store/project-groups/']
  ),
  featureRoute(
    'feature.new-workspace',
    [
      'tests/e2e/workspaces/project-admission/new-workspace-cross-project-dialog.spec.ts',
      'tests/e2e/workspaces/project-admission/new-workspace-linked-item-project-switch.spec.ts'
    ],
    [`${COMPONENTS}new-workspace/`]
  ),
  featureRoute(
    'feature.startup-exec-readiness',
    ['tests/e2e/remote/paired-runtime/workspace-routing/paired-startup-exec-readiness.spec.ts'],
    [
      'src/main/daemon/sessions/session-shell-ready-barrier.ts',
      'src/main/daemon/shell-readiness/',
      'src/main/pty/shell-startup/shell-prompt-readiness-probe.ts',
      'src/main/pty/shell-startup/shell-startup-output-scanner.ts',
      'src/main/pty/shell-startup/shell-templates.ts',
      'tests/e2e/terminal/readiness/startup-exec-readiness-oracle.ts'
    ]
  )
]
