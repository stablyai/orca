import type { CommandHandler } from './dispatch'
import { BROWSER_HANDLER_GROUPS } from './browser-handler-groups'
import { JIRA_HANDLER_GROUP } from './jira-handler-group'
import { LINEAR_HANDLER_GROUP } from './linear-handler-group'
import { REFERENCE_HANDLER_GROUP } from './reference-handler-group'

export type HandlerGroup = {
  name: string
  // Eager keys allow routing and duplicate checks without importing each handler graph.
  keys: readonly string[]
  load: () => Promise<Record<string, CommandHandler>>
}

// handler-group-manifest.test.ts checks keys against the real exports to prevent drift.
export const HANDLER_GROUPS: readonly HandlerGroup[] = [
  JIRA_HANDLER_GROUP,
  LINEAR_HANDLER_GROUP,
  REFERENCE_HANDLER_GROUP,
  {
    name: 'core',
    keys: ['claude-teams', 'open', 'serve', 'status'],
    load: async () => (await import('./handlers/core.js')).CORE_HANDLERS
  },
  {
    name: 'serve-restore',
    keys: ['serve restore resume'],
    load: async () => (await import('./handlers/serve-restore.js')).SERVE_RESTORE_HANDLERS
  },
  {
    name: 'serve-service',
    keys: ['serve service install', 'serve service status', 'serve service uninstall'],
    load: async () => (await import('./handlers/serve-service.js')).SERVE_SERVICE_HANDLERS
  },
  {
    name: 'account',
    keys: ['account add', 'account list', 'account select', 'account rm'],
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
    keys: [
      'repo list',
      'repo add',
      'repo show',
      'repo set',
      'repo set-base-ref',
      'repo search-refs'
    ],
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
      'terminal set-pane-title',
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
      'orchestration reset'
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
    name: 'agent-launch',
    keys: ['agent launch'],
    load: async () => (await import('./handlers/agent-launch.js')).AGENT_LAUNCH_HANDLERS
  },
  {
    name: 'connector',
    keys: [
      'connector start',
      'connector send',
      'connector prompt',
      'connector answer',
      'connector cancel',
      'connector watch'
    ],
    load: async () => (await import('./handlers/connector.js')).CONNECTOR_HANDLERS
  },
  {
    name: 'profile-state',
    keys: ['profile state exports', 'profile state rollback'],
    load: async () => (await import('./handlers/profile-state.js')).PROFILE_STATE_HANDLERS
  },
  {
    name: 'diagnostics',
    keys: ['diagnostics memory', 'terminal-daemon status', 'terminal-daemon restart'],
    load: async () => (await import('./handlers/diagnostics.js')).DIAGNOSTICS_HANDLERS
  },
  {
    name: 'speech',
    keys: ['speech openai-key status', 'speech openai-key set', 'speech openai-key clear'],
    load: async () => (await import('./handlers/speech.js')).SPEECH_HANDLERS
  },
  {
    name: 'introspection',
    keys: ['agent-context'],
    load: async () => (await import('./handlers/introspection.js')).INTROSPECTION_HANDLERS
  },
  {
    name: 'environment',
    keys: [
      'host name',
      'host list',
      'environment add',
      'environment list',
      'environment show',
      'environment rm'
    ],
    load: async () => (await import('./handlers/environment.js')).ENVIRONMENT_HANDLERS
  },
  {
    name: 'managed-server',
    keys: [
      'environment status',
      'environment update',
      'environment rollback',
      'environment recover',
      'environment stop',
      'environment cancel-stop',
      'environment forget'
    ],
    load: async () => (await import('./handlers/managed-server.js')).MANAGED_SERVER_HANDLERS
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
  },
  {
    name: 'search',
    keys: ['search'],
    load: async () => (await import('./handlers/search.js')).SEARCH_HANDLERS
  },
  {
    name: 'ports',
    keys: ['ports'],
    load: async () => (await import('./handlers/ports.js')).PORTS_HANDLERS
  }
]
