import type { PageClosurePins } from './page-closure'

/**
 * The C2 closure families reached by choosing a task source, and what each golden did at the bridge.
 *
 * The other half of the families C2 adds: the providers the route can open on (`taskSource` is this
 * domain's one query param), the lists and project boards they serve, the creates that add to them,
 * and the workspace a task is taken into. `c2-work-item-closure-families.ts` is what happens after
 * one of these rows is opened.
 *
 * Same rule as its sibling, and the same warning: the table is data for `c2-page-closure.ts`, whose
 * gate asserts these verdicts against a run rather than trusting the file.
 */
export const C2_TASK_SOURCE_CLOSURE_FAMILIES: PageClosurePins = {
  'linear.select-workspace-picker': {
    'linear-select-workspace': 'identical',
    'matrix-linear.select-workspace-picker-linear.selectworkspace-1': 'result-absent-settlement'
  },
  'project-explicit-false': {
    b2: 'identical',
    'matrix-project-explicit-false-github.project.updateissuebyslug-1': 'result-absent-settlement'
  },
  'settings-best-effort': {
    'matrix-settings-best-effort-settings.update-1': 'result-absent-settlement',
    'settings-task-write': 'identical',
    'tw-task-preferences-resume-write': 'identical'
  },
  'settings.task-hydration': {
    'lifecycle-settings-task-hydration-fulfilled': 'identical',
    'matrix-settings.task-hydration-linear.status-1': 'result-absent-settlement',
    'matrix-settings.task-hydration-preflight.check-1': 'result-absent-settlement',
    'matrix-settings.task-hydration-settings.get-1': 'result-absent-settlement',
    'matrix-settings.task-hydration-status.get-1': 'result-absent-settlement',
    'matrix-settings.task-hydration-ui.get-1': 'result-absent-settlement',
    'schedules-settings-task-hydration-fulfilled': 'identical',
    'settings-task-hydration-fulfilled': 'identical',
    'settings-task-hydration-refuse-after-data': 'identical',
    'settings-task-hydration-refused': 'identical',
    'settings-task-hydration-transport-error': 'identical'
  },
  'settings.task-workspace': {
    'matrix-settings.task-workspace-settings.get-1': 'result-absent-settlement',
    'settings-task-workspace-fulfilled': 'identical',
    'settings-task-workspace-refused': 'identical',
    'settings-task-workspace-transport-error': 'identical'
  },
  'settings.task-workspace-create': {
    'matrix-settings.task-workspace-create-settings.get-1': 'result-absent-settlement',
    'matrix-settings.task-workspace-create-worktree.create-1': 'result-absent-settlement',
    'settings-task-workspace-create-linear': 'identical',
    'settings-task-workspace-create-pr-start-point': 'identical'
  },
  'tasks.linear-connect': {
    'matrix-tasks.linear-connect-linear.connect-1': 'result-absent-settlement',
    'tk-linear-connect': 'identical'
  },
  'tasks.linear-team-context': {
    'matrix-tasks.linear-team-context-linear.listteams-1': 'result-absent-settlement',
    'matrix-tasks.linear-team-context-linear.teamstates-1': 'result-absent-settlement',
    'tk-linear-team-context': 'identical'
  },
  'tasks.project-board-load': {
    'matrix-tasks.project-board-load-github.project.listaccessible-1': 'result-absent-settlement',
    'matrix-tasks.project-board-load-github.project.listviews-1': 'result-absent-settlement',
    'matrix-tasks.project-board-load-github.project.listviews-2': 'result-absent-settlement',
    'matrix-tasks.project-board-load-github.project.resolveref-1': 'result-absent-settlement',
    'matrix-tasks.project-board-load-github.project.viewtable-1': 'result-absent-settlement',
    'tk-project-board-load': 'identical'
  },
  'tasks.project-repo-slugs': {
    'matrix-tasks.project-repo-slugs-github.reposlug-1': 'result-absent-settlement',
    'tk-project-repo-slugs': 'identical'
  },
  'tasks.provider-load': {
    'matrix-tasks.provider-load-github.countworkitems-1': 'params-undefined',
    'matrix-tasks.provider-load-github.listworkitems-1': 'params-undefined',
    'matrix-tasks.provider-load-linear.listteams-1': 'params-undefined',
    'matrix-tasks.provider-load-linear.status-1': 'params-undefined',
    'matrix-tasks.provider-load-settings.update-1': 'params-undefined',
    'tk-provider-load': 'params-undefined'
  },
  'tasks.route-repo-list': {
    'matrix-tasks.route-repo-list-repo.list-1': 'result-absent-settlement',
    'tasks-route-repo-list': 'identical'
  },
  'tasks.task-create-github': {
    'matrix-tasks.task-create-github-github.createissue-1': 'result-absent-settlement',
    'matrix-tasks.task-create-github-repo.update-1': 'result-absent-settlement',
    'tk-create-github': 'identical'
  },
  'tasks.task-create-gitlab': {
    'matrix-tasks.task-create-gitlab-gitlab.createissue-1': 'result-absent-settlement',
    'tk-create-gitlab': 'identical'
  },
  'tasks.task-create-linear': {
    'matrix-tasks.task-create-linear-linear.createissue-1': 'result-absent-settlement',
    'tk-create-linear': 'identical'
  },
  'tasks.task-list-gitlab-items': {
    'matrix-tasks.task-list-gitlab-items-gitlab.listworkitems-1': 'params-undefined',
    'tk-list-gitlab-items': 'params-undefined'
  },
  'tasks.task-list-gitlab-todos': {
    'matrix-tasks.task-list-gitlab-todos-gitlab.todos-1': 'result-absent-settlement',
    'tk-list-gitlab-todos': 'identical'
  },
  'tasks.task-list-linear': {
    'matrix-tasks.task-list-linear-linear.listissues-1': 'result-absent-settlement',
    'matrix-tasks.task-list-linear-linear.searchissues-1': 'result-absent-settlement',
    'tk-list-linear': 'identical'
  },
  'tasks.workspace-source': {
    'matrix-tasks.workspace-source-repo.searchrefs-1': 'result-absent-settlement',
    'matrix-tasks.workspace-source-repo.sparsepresets-1': 'result-absent-settlement',
    'tw-workspace-source-presets': 'identical',
    'tw-workspace-source-presets-refused': 'identical'
  },
  'tasks.workspace-sparse': {
    'matrix-tasks.workspace-sparse-repo.savesparsepreset-1': 'result-absent-settlement',
    'matrix-tasks.workspace-sparse-ssh.getstate-1': 'result-absent-settlement',
    'tw-workspace-sparse-missing-preset': 'identical',
    'tw-workspace-sparse-saved': 'identical'
  },
  'tasks.workspace-ssh': {
    'matrix-tasks.workspace-ssh-preflight.detectremoteagents-1': 'result-absent-settlement',
    'matrix-tasks.workspace-ssh-repo.hooks-1': 'result-absent-settlement',
    'matrix-tasks.workspace-ssh-ssh.connect-1': 'result-absent-settlement',
    'tw-workspace-ssh-connect-refused': 'identical',
    'tw-workspace-ssh-connected': 'identical',
    'tw-workspace-ssh-not-ready': 'identical'
  },
  'tasks.workspace-ssh-local': {
    'matrix-tasks.workspace-ssh-local-preflight.detectagents-1': 'result-absent-settlement',
    'tw-workspace-ssh-local-agents': 'identical'
  }
}
