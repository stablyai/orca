import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PIPELINE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['pipelines', 'template-list'],
    summary: 'List Pipeline templates',
    usage: 'orca pipelines template-list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['pipelines', 'run'],
    summary: 'Create a Pipeline run',
    usage:
      'orca pipelines run --template <id> --repo <repo> --source-branch <branch> --target-branch <branch> --task-source github --task-owner <owner> --task-repo <repo> --prd-issue <number> --planner-agent <agent> --implementer-agent <agent> --merger-agent <agent> [--reviewer-agent <agent>] [--max-concurrent <n>] [--max-iterations <n>] [--verify-command <cmd>] [--verify-timeout-seconds <n>] [--execution-target-type <local|ssh>] [--execution-target-id <id>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'template',
      'repo',
      'source-branch',
      'target-branch',
      'task-source',
      'task-owner',
      'task-repo',
      'prd-issue',
      'planner-agent',
      'implementer-agent',
      'reviewer-agent',
      'merger-agent',
      'max-concurrent',
      'max-iterations',
      'verify-command',
      'verify-timeout-seconds',
      'execution-target-type',
      'execution-target-id'
    ]
  },
  {
    path: ['pipelines', 'list'],
    summary: 'List Pipeline runs',
    usage: 'orca pipelines list [--repo <repo>] [--status <status>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'status', 'limit']
  },
  {
    path: ['pipelines', 'show'],
    summary: 'Show Pipeline run details',
    usage: 'orca pipelines show --run <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run']
  },
  {
    path: ['pipelines', 'cancel'],
    summary: 'Cancel a Pipeline run',
    usage: 'orca pipelines cancel --run <run_id> [--preserve-worktrees] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'preserve-worktrees']
  },
  {
    path: ['pipelines', 'logs'],
    summary: 'Show Pipeline logs',
    usage:
      'orca pipelines logs --run <run_id> [--stage <stage_id>] [--task <task_id>] [--limit <n>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'stage', 'task', 'limit']
  },
  {
    path: ['pipelines', 'release-stale-reservation'],
    summary: 'Release a stale Pipeline reservation',
    usage:
      'orca pipelines release-stale-reservation --reservation <reservation_id> --confirm [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'reservation', 'confirm']
  },
  {
    path: ['pipelines', 'recovery-reports'],
    summary: 'List Pipeline recovery reports',
    usage:
      'orca pipelines recovery-reports [--repo <repo>] [--prd-issue <number>] [--status <status>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'prd-issue', 'status']
  },
  {
    path: ['pipelines', 'recovery-report-acknowledge'],
    summary: 'Acknowledge a Pipeline recovery report',
    usage: 'orca pipelines recovery-report-acknowledge --report <report_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'report']
  }
]
