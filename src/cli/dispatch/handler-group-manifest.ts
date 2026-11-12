import type { CommandHandler } from './dispatch'
import { BROWSER_HANDLER_GROUPS } from '../browser/browser-handler-groups'
import { JIRA_HANDLER_GROUP } from '../jira/jira-handler-group'
import { LINEAR_HANDLER_GROUP } from '../linear/linear-handler-group'
import { REFERENCE_HANDLER_GROUP } from '../references/reference-handler-group'
import { SERVE_PAIRING_HANDLER_GROUPS } from '../server/serve-pairing-handler-groups'
import { PLUGIN_HANDLER_GROUPS } from '../plugins/plugin-handler-groups'
import { HOST_HANDLER_GROUPS } from '../hosts/host-handler-groups'
import { WORKTREE_HANDLER_GROUPS } from '../workspaces/worktree-handler-groups'

export type HandlerGroup = {
  name: string
  // Eager keys allow routing and duplicate checks without importing each handler graph.
  keys: readonly string[]
  load: () => Promise<Record<string, CommandHandler>>
}

export const HANDLER_GROUPS: readonly HandlerGroup[] = [
  JIRA_HANDLER_GROUP,
  LINEAR_HANDLER_GROUP,
  REFERENCE_HANDLER_GROUP,
  {
    name: 'core',
    keys: ['claude-teams', 'open', 'serve', 'status'],
    load: async () => (await import('../runtime/cli-lifecycle-handlers.js')).CORE_HANDLERS
  },
  ...SERVE_PAIRING_HANDLER_GROUPS,
  {
    name: 'serve-reset-identity',
    keys: ['serve reset-identity'],
    load: async () =>
      (await import('../server/serve-reset-identity.js')).SERVE_RESET_IDENTITY_HANDLERS
  },
  {
    name: 'serve-service',
    keys: ['serve service install', 'serve service status', 'serve service uninstall'],
    load: async () => (await import('../server/serve-service.js')).SERVE_SERVICE_HANDLERS
  },
  {
    name: 'account',
    keys: ['account add', 'account list', 'account select', 'account rm'],
    load: async () => (await import('../accounts/account.js')).ACCOUNT_HANDLERS
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
    load: async () => (await import('../artifacts/artifacts.js')).ARTIFACT_HANDLERS
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
    load: async () => (await import('../automations/automations.js')).AUTOMATION_HANDLERS
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
    load: async () => (await import('../projects/project.js')).PROJECT_HANDLERS
  },
  {
    name: 'repo',
    keys: [
      'repo list',
      'repo add',
      'repo show',
      'repo set',
      'repo hide',
      'repo unhide',
      'repo set-base-ref',
      'repo search-refs'
    ],
    load: async () => (await import('../projects/repo.js')).REPO_HANDLERS
  },
  ...WORKTREE_HANDLER_GROUPS,
  {
    name: 'file',
    keys: ['file open', 'file diff', 'file open-changed'],
    load: async () => (await import('../files/file.js')).FILE_HANDLERS
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
    load: async () => (await import('../terminals/terminal.js')).TERMINAL_HANDLERS
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
      'orchestration approve',
      'orchestration deny',
      'orchestration worker-abandon',
      'orchestration worker-release',
      'orchestration worker-keep-open',
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
    load: async () =>
      (await import('../orchestration/orchestration-handlers.js')).ORCHESTRATION_HANDLERS
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
    load: async () => (await import('../emulator/emulator.js')).EMULATOR_HANDLERS
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
    load: async () => (await import('../computer/computer.js')).COMPUTER_HANDLERS
  },
  {
    name: 'agent-hooks',
    keys: ['agent hooks prepare-codex', 'agent hooks status', 'agent hooks off', 'agent hooks on'],
    load: async () => (await import('../agents/agent-hooks.js')).AGENT_HOOK_HANDLERS
  },
  {
    name: 'agent-launch',
    keys: ['agent launch'],
    load: async () => (await import('../agents/agent-launch.js')).AGENT_LAUNCH_HANDLERS
  },
  {
    name: 'chat',
    keys: ['chat rename'],
    load: async () => (await import('../agents/chat.js')).CHAT_HANDLERS
  },
  {
    name: 'connector',
    keys: [
      'connector start',
      'connector send',
      'connector prompt',
      'connector answer',
      'connector cancel',
      'connector watch',
      'connector reply'
    ],
    load: async () => (await import('../connectors/connector.js')).CONNECTOR_HANDLERS
  },
  {
    name: 'profile-state',
    keys: ['profile state exports', 'profile state rollback'],
    load: async () => (await import('../profiles/profile-state.js')).PROFILE_STATE_HANDLERS
  },
  {
    name: 'diagnostics',
    keys: ['diagnostics memory', 'terminal-daemon status', 'terminal-daemon restart'],
    load: async () => (await import('../diagnostics/diagnostics.js')).DIAGNOSTICS_HANDLERS
  },
  {
    name: 'speech',
    keys: ['speech openai-key status', 'speech openai-key set', 'speech openai-key clear'],
    load: async () => (await import('../speech/speech.js')).SPEECH_HANDLERS
  },
  {
    name: 'introspection',
    keys: ['agent-context'],
    load: async () =>
      (await import('../discovery/agent-context-handlers.js')).INTROSPECTION_HANDLERS
  },
  ...HOST_HANDLER_GROUPS,
  {
    name: 'skill-sharing',
    keys: ['skills installed', 'skills share'],
    load: async () => (await import('../skills/skill-sharing.js')).SKILL_SHARING_HANDLERS
  },
  ...PLUGIN_HANDLER_GROUPS,
  {
    name: 'skills',
    keys: ['skills list', 'skills get', 'skills install', 'skills update'],
    load: async () => (await import('../skills/skills.js')).SKILL_HANDLERS
  },
  {
    name: 'search',
    keys: ['search'],
    load: async () => (await import('../session-search/search.js')).SEARCH_HANDLERS
  },
  {
    name: 'ports',
    keys: ['ports'],
    load: async () => (await import('../workspace-ports/ports.js')).PORTS_HANDLERS
  }
]
