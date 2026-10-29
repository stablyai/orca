// History goldens require complete residual certification; unchanged families retain their legacy labels.
// Measure the .web entry; its native sibling imports shell-only bundle operations that the page never loads.

import type { PageClosurePins } from './page-closure'

export const C5_PAGE_CLOSURE: PageClosurePins = {
  'aiVault.history': {
    'aivault-history-scan-fulfilled': 'write-ordinal',
    'aivault-history-scan-unsupported': 'write-ordinal',
    'aivault-history-scan-worktrees-late': 'write-ordinal',
    'matrix-aivault.history-aivault.listsessions-1': 'result-absent-settlement',
    'matrix-aivault.history-status.get-1': 'result-absent-settlement'
  },
  'aiVault.history-screen': {
    'aivault-history-screen-listed': 'write-ordinal',
    'aivault-history-screen-worktrees': 'write-ordinal',
    'matrix-aivault.history-screen-platform-status': 'result-absent-settlement',
    'matrix-aivault.history-screen-status.get-2': 'result-absent-settlement',
    'matrix-aivault.history-screen-worktree.ps-1': 'result-absent-settlement'
  },
  'aiVault.resume-launch': {
    'aivault-resume-launch-create-refused': 'identical',
    'aivault-resume-launch-invalid-tab': 'identical',
    'aivault-resume-launch-locked': 'identical',
    'aivault-resume-launch-sent': 'identical',
    'matrix-aivault.resume-launch-session.tabs.createterminal-1': 'result-absent-settlement',
    'matrix-aivault.resume-launch-terminal.send-1': 'result-absent-settlement'
  },
  'aiVault.resume-preparation': {
    'aivault-resume-prepare-refused': 'identical',
    'aivault-resume-prepare-repin': 'identical',
    'aivault-resume-prepare-skipped': 'identical',
    'aivault-resume-prepare-unavailable': 'identical',
    'matrix-aivault.resume-preparation-aivault.preparesessionresume-1': 'result-absent-settlement'
  },
  'components.execution-target': {
    'components-target-ssh': 'identical',
    'matrix-components.execution-target-preflight.detectremoteagents-1': 'result-absent-settlement',
    'matrix-components.execution-target-ssh.connect-1': 'result-absent-settlement',
    'matrix-components.execution-target-ssh.getstate-1': 'result-absent-settlement'
  },
  'components.execution-target-local': {
    'components-target-local': 'identical',
    'matrix-components.execution-target-local-preflight.detectagents-1': 'result-absent-settlement'
  },
  'components.new-workspace-repositories': {
    'matrix-components.new-workspace-repositories-repo.list-1': 'result-absent-settlement',
    'new-workspace-repositories-fulfilled': 'identical'
  },
  'components.setup-script': {
    'components-setup-ask': 'identical',
    'matrix-components.setup-script-repo.hooks-1': 'result-absent-settlement'
  },
  'host-worktree-refresh': {
    'host-worktree-refresh-stream': 'write-ordinal',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-1':
      'result-absent-stream-release',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-2':
      'result-absent-stream-release',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-1-3':
      'result-absent-stream-release',
    'matrix-host-worktree-refresh-runtime.clientevents.subscribe-2-1': 'write-ordinal'
  },
  'host.view-settings': {
    'host-view-settings-sync': 'identical',
    'matrix-host.view-settings-settings.get-1': 'result-absent-settlement',
    'matrix-host.view-settings-ui.get-1': 'result-absent-settlement',
    'matrix-host.view-settings-ui.set-1': 'result-absent-settlement'
  },
  'host.worktree-actions': {
    'host-worktree-actions-pin-open-delete': 'identical',
    'host-worktree-delete-refused': 'identical',
    'matrix-host.worktree-actions-worktree.activate-1': 'result-absent-settlement',
    'matrix-host.worktree-actions-worktree.rm-1': 'result-absent-settlement',
    'matrix-host.worktree-actions-worktree.set-1': 'result-absent-settlement'
  },
  'settings.repo-metadata': {
    'matrix-settings.repo-metadata-host.platform-1': 'result-absent-settlement',
    'matrix-settings.repo-metadata-repo.list-1': 'result-absent-settlement',
    'matrix-settings.repo-metadata-settings.get-1': 'result-absent-settlement',
    'matrix-settings.repo-metadata-ssh.listtargetsummaries-1': 'result-absent-settlement',
    'schedules-settings-repo-metadata-fulfilled': 'identical',
    'settings-repo-cache-expiry': 'identical',
    'settings-repo-metadata-fulfilled': 'identical',
    'settings-repo-metadata-icons': 'identical',
    'settings-repo-metadata-refuse-after-data': 'identical',
    'settings-repo-metadata-refused': 'identical',
    'settings-repo-metadata-single-host': 'identical',
    'settings-repo-metadata-transport-error': 'identical'
  },
  'settings.resume-metadata': {
    'matrix-settings.resume-metadata-folderworkspace.list-1': 'result-absent-settlement',
    'matrix-settings.resume-metadata-projectgroup.list-1': 'result-absent-settlement',
    'matrix-settings.resume-metadata-repo.list-1': 'result-absent-settlement',
    'matrix-settings.resume-metadata-settings.get-1': 'result-absent-settlement',
    'matrix-settings.resume-metadata-worktree.ps-1': 'result-absent-settlement',
    'schedules-settings-resume-metadata-fulfilled': 'identical',
    'settings-resume-metadata-fulfilled': 'identical',
    'settings-resume-metadata-refuse-after-data': 'identical',
    'settings-resume-metadata-refused': 'identical',
    'settings-resume-metadata-transport-error': 'identical'
  },
  'settings.workspace-context': {
    'lifecycle-settings-workspace-context-fulfilled': 'identical',
    'matrix-settings.workspace-context-jira.status-1': 'result-absent-settlement',
    'matrix-settings.workspace-context-linear.status-1': 'result-absent-settlement',
    'matrix-settings.workspace-context-preflight.check-1': 'result-absent-settlement',
    'matrix-settings.workspace-context-settings.get-1': 'result-absent-settlement',
    'matrix-settings.workspace-context-ui.get-1': 'result-absent-settlement',
    'schedules-settings-workspace-context-fulfilled': 'identical',
    'settings-workspace-context-fulfilled': 'identical',
    'settings-workspace-context-refuse-after-data': 'identical',
    'settings-workspace-context-refused': 'identical',
    'settings-workspace-context-transport-error': 'identical'
  },
  'settings.workspace-submit': {
    'matrix-settings.workspace-submit-settings.get-1': 'result-absent-settlement',
    'settings-workspace-submit-fulfilled': 'identical',
    'settings-workspace-submit-refused': 'identical',
    'settings-workspace-submit-transport-error': 'identical'
  },
  'tasks.paste-lookup': {
    'matrix-tasks.paste-lookup-github.reposlug-1': 'result-absent-settlement',
    'matrix-tasks.paste-lookup-github.workitem-1': 'result-absent-settlement',
    'matrix-tasks.paste-lookup-github.workitembyownerrepo-1': 'result-absent-settlement',
    'matrix-tasks.paste-lookup-gitlab.workitembypath-1': 'result-absent-settlement',
    'tw-paste-lookup-resolved': 'identical',
    'tw-paste-lookup-slug-refused': 'identical',
    'tw-paste-lookup-slug-unsupported': 'identical'
  },
  'tasks.smart-source-search': {
    'matrix-tasks.smart-source-search-github.listworkitems-1': 'params-undefined',
    'matrix-tasks.smart-source-search-gitlab.listworkitems-1': 'params-undefined',
    'matrix-tasks.smart-source-search-linear.listissues-1': 'params-undefined',
    'matrix-tasks.smart-source-search-linear.searchissues-1': 'params-undefined',
    'matrix-tasks.smart-source-search-repo.searchrefs-1': 'params-undefined',
    'tw-smart-search-all-providers': 'params-undefined',
    'tw-smart-search-gitlab-provider-error': 'identical',
    'tw-smart-search-linear-listed': 'params-undefined'
  },
  'transport.host-status-gates': {
    'matrix-transport.host-status-gates-status.get-1': 'result-absent-settlement',
    'transport-host-status-gates-drop-keeps-capabilities': 'identical',
    'transport-host-status-gates-ready': 'identical',
    'transport-host-status-gates-refused-degrades': 'identical'
  },
  'worktree.agent-launch-create': {
    'matrix-worktree.agent-launch-create-agent.launch-1': 'result-absent-settlement',
    'tw-create-retry-agent-launched': 'identical'
  },
  'worktree.catalog-snapshot': {
    'matrix-worktree.catalog-snapshot-worktree.ps-1': 'result-absent-settlement',
    'worktree-catalog-snapshot': 'identical',
    'worktree-catalog-snapshot-unreadable': 'result-absent-settlement'
  },
  'worktree.create-retry': {
    'matrix-worktree.create-retry-worktree.create-1': 'result-absent-settlement',
    'tw-create-retry-ambiguous-after-drop': 'identical',
    'tw-create-retry-ambiguous-while-connected': 'identical',
    'tw-create-retry-ambiguous-without-idempotency': 'identical',
    'tw-create-retry-created': 'identical',
    'tw-create-retry-name-collision': 'identical',
    'tw-create-retry-unretryable-refusal': 'identical',
    'tw-create-retry-warning-kept': 'identical'
  },
  'worktree.hosted-base': {
    'matrix-worktree.hosted-base-worktree.resolvemrbase-1': 'result-absent-settlement',
    'matrix-worktree.hosted-base-worktree.resolveprbase-1': 'result-absent-settlement',
    'tw-hosted-base-resolved': 'identical',
    'tw-hosted-base-soft-error': 'identical'
  },
  'worktree.retired-names': {
    'matrix-worktree.retired-names-worktree.listretirednames-1': 'result-absent-settlement',
    'worktree-retired-names': 'identical'
  },
  'worktree.runtime-capabilities': {
    'matrix-worktree.runtime-capabilities-status.get-1': 'result-absent-settlement',
    'tw-capabilities-advertised': 'identical',
    'tw-capabilities-cutover-retried': 'identical',
    'tw-capabilities-legacy-idempotency': 'identical'
  },
  'worktree.setup-hook-trust': {
    'matrix-worktree.setup-hook-trust-ui.set-1': 'result-absent-settlement',
    'tw-setup-hook-trust-always': 'identical',
    'tw-setup-hook-trust-approved': 'identical'
  }
}
