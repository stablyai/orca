import type { CommandHandler } from './dispatch'
import { BROWSER_HANDLER_GROUPS } from './browser-handler-groups'

export type HandlerGroup = {
  name: string
  // Why: eager string keys let dispatch build (and duplicate-check) the whole
  // command table without loading any group's transitive module graph.
  keys: readonly string[]
  load: () => Promise<Record<string, CommandHandler>>
}

// Why: `keys` mirrors each group's exported record and is verified against the
// real exports by handler-group-manifest.test.ts, so drift fails CI, not dispatch.
export const HANDLER_GROUPS: readonly HandlerGroup[] = [
  {
    name: 'core',
    keys: ['claude-teams', 'open', 'serve', 'status'],
    load: async () => (await import('./handlers/core.js')).CORE_HANDLERS
  },
  {
    name: 'account',
    keys: ['account add', 'account list'],
    load: async () => (await import('./handlers/account.js')).ACCOUNT_HANDLERS
  },
  {
    name: 'artifacts',
    keys: [
      'artifacts list',
      'artifacts share',
      'artifacts update',
      'artifacts unshare',
      'artifacts delete'
    ],
    load: async () => (await import('./handlers/artifacts.js')).ARTIFACT_HANDLERS
  },
  {
    name: 'automations',
    keys: [
      'automations list',
      'automations show',
      'automations create',
      'automations edit',
      'automations remove',
      'automations run',
      'automations runs'
    ],
    load: async () => (await import('./handlers/automations.js')).AUTOMATION_HANDLERS
  },
  {
    name: 'project',
    keys: [
      'project list',
      'project setups',
      'project setup-existing-folder',
      'project setup-clone',
      'project setup-create',
      'project setup-update',
      'project setup-delete'
    ],
    load: async () => (await import('./handlers/project.js')).PROJECT_HANDLERS
  },
  {
    name: 'repo',
    keys: ['repo list', 'repo add', 'repo show', 'repo set-base-ref', 'repo search-refs'],
    load: async () => (await import('./handlers/repo.js')).REPO_HANDLERS
  },
  {
    name: 'worktree',
    keys: [
      'worktree ps',
      'worktree list',
      'worktree show',
      'worktree current',
      'worktree create',
      'worktree set',
      'worktree rm'
    ],
    load: async () => (await import('./handlers/worktree.js')).WORKTREE_HANDLERS
  },
  {
    name: 'file',
    keys: ['file open', 'file diff', 'file open-changed'],
    load: async () => (await import('./handlers/file.js')).FILE_HANDLERS
  },
  {
    name: 'terminal',
    keys: [
      'terminal list',
      'terminal show',
      'terminal read',
      'terminal send',
      'terminal wait',
      'terminal stop',
      'terminal rename',
      'terminal create',
      'terminal switch',
      'terminal close',
      'terminal split'
    ],
    load: async () => (await import('./handlers/terminal.js')).TERMINAL_HANDLERS
  },
  ...BROWSER_HANDLER_GROUPS,
  {
    name: 'orchestration',
    keys: [
      'orchestration run-create',
      'orchestration run-use',
      'orchestration run-current',
      'orchestration run-list',
      'orchestration run-show',
      'orchestration send',
      'orchestration check',
      'orchestration reply',
      'orchestration inbox',
      'orchestration task-create',
      'orchestration task-list',
      'orchestration task-update',
      'orchestration worker-start',
      'orchestration worker-show',
      'orchestration worker-read',
      'orchestration worker-stop',
      'orchestration worker-abandon',
      'orchestration worker-release',
      'orchestration worker-retain',
      'orchestration worker-list',
      'orchestration dispatch',
      'orchestration ask',
      'orchestration dispatch-show',
      'orchestration coordinator-start',
      'orchestration coordinator-stop',
      'orchestration request-show',
      'orchestration gate-create',
      'orchestration gate-resolve',
      'orchestration gate-list',
      'orchestration reset',
      'orchestration collaboration-publish',
      'orchestration collaboration-checkpoint',
      'orchestration collaboration-ack'
    ],
    load: async () => (await import('./handlers/orchestration.js')).ORCHESTRATION_HANDLERS
  },
  {
    name: 'emulator',
    keys: [
      'emulator list',
      'emulator devices',
      'emulator attach',
      'emulator tap',
      'emulator type',
      'emulator gesture',
      'emulator button',
      'emulator rotate',
      'emulator exec',
      'emulator kill',
      'emulator shutdown',
      'emulator install',
      'emulator launch',
      'emulator permissions',
      'emulator ax',
      'emulator logcat'
    ],
    load: async () => (await import('./handlers/emulator.js')).EMULATOR_HANDLERS
  },
  {
    name: 'computer',
    keys: [
      'computer capabilities',
      'computer list-apps',
      'computer permissions',
      'computer list-windows',
      'computer get-app-state',
      'computer click',
      'computer perform-secondary-action',
      'computer scroll',
      'computer drag',
      'computer type-text',
      'computer press-key',
      'computer hotkey',
      'computer paste-text',
      'computer set-value'
    ],
    load: async () => (await import('./handlers/computer.js')).COMPUTER_HANDLERS
  },
  {
    name: 'agent-hooks',
    keys: ['agent hooks prepare-codex', 'agent hooks status', 'agent hooks off', 'agent hooks on'],
    load: async () => (await import('./handlers/agent-hooks.js')).AGENT_HOOK_HANDLERS
  },
  {
    name: 'diagnostics',
    keys: ['diagnostics memory'],
    load: async () => (await import('./handlers/diagnostics.js')).DIAGNOSTICS_HANDLERS
  },
  {
    name: 'introspection',
    keys: ['agent-context'],
    load: async () => (await import('./handlers/introspection.js')).INTROSPECTION_HANDLERS
  },
  {
    name: 'environment',
    keys: [
      'host list',
      'environment add',
      'environment list',
      'environment show',
      'environment rm'
    ],
    load: async () => (await import('./handlers/environment.js')).ENVIRONMENT_HANDLERS
  },
  {
    name: 'linear',
    keys: [
      'linear save-issue',
      'linear list-issues',
      'linear relation add',
      'linear relation remove',
      'linear issue',
      'linear search',
      'linear team list',
      'linear team members',
      'linear team states',
      'linear team labels',
      'linear project list',
      'linear list',
      'linear status set',
      'linear assignee set',
      'linear assignee clear',
      'linear priority set',
      'linear priority clear',
      'linear estimate set',
      'linear estimate clear',
      'linear due-date set',
      'linear due-date clear',
      'linear label add',
      'linear label remove',
      'linear label set',
      'linear comment add',
      'linear attach',
      'linear create'
    ],
    load: async () => (await import('./handlers/linear.js')).LINEAR_HANDLERS
  },
  {
    name: 'vm',
    keys: ['vm recipe doctor'],
    load: async () => (await import('./handlers/vm.js')).VM_HANDLERS
  },
  {
    name: 'skill-sharing',
    keys: ['skills installed', 'skills share'],
    load: async () => (await import('./handlers/skill-sharing.js')).SKILL_SHARING_HANDLERS
  },
  {
    name: 'skills',
    keys: ['skills list', 'skills get', 'skills install', 'skills update'],
    load: async () => (await import('./handlers/skills.js')).SKILL_HANDLERS
  }
]
