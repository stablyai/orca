import type { RpcAnyMethodDeclaration } from '../core'
import { STATUS_METHODS } from './host-management/status'
import { DESKTOP_WINDOW_METHODS } from './host-management/desktop-window'
import { SIDEBAR_INPUT_METHODS } from './sidebar-inputs/sidebar-inputs'
import { SIDEBAR_REPO_ICON_METHODS } from './sidebar-inputs/sidebar-repo-icons'
import { REPO_METHODS } from './projects/repo'
import { WORKTREE_METHODS } from './workspaces/worktree'
import { AGENT_ACTIVITY_METHODS } from './workspaces/agent-activity-methods'
import { TERMINAL_METHODS } from './terminal/terminal'
import { TERMINAL_DAEMON_METHODS } from './terminal/terminal-daemon'
import { NOTIFICATION_METHODS } from './notifications/notifications'
import { PREFLIGHT_METHODS } from './preflight/preflight'
import { SESSION_TAB_METHODS } from './session-tabs/session-tabs'
import {
  LAYOUT_APPLY_METHODS,
  LAYOUT_VIEW_REPORT_METHODS,
  WORKSPACE_LAYOUT_METHODS
} from './workspace-layout/workspace-layout'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import { CLIENT_UI_METHODS } from './client-state/client-ui'
import { CLIENT_EVENT_METHODS } from './client-events/client-events'
import { HOST_CAPABILITY_METHODS } from './host-management/host-capabilities'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from './client-events/runtime-client-capabilities'
import { WORKSPACE_PORT_METHODS } from './workspace-ports/workspace-ports'
import { AGENT_HOOK_METHODS } from './agent-hooks/agent-hooks'
import { FILE_METHODS } from './files/files'
import { GIT_METHODS } from './source-control/git/git'
import { CLIPBOARD_METHODS } from './clipboard/clipboard'
import { UPDATER_METHODS } from './updater/updater'
import { ORCA_ACCOUNT_METHODS } from './orca-account'

export type LazyRpcMethodGroup = {
  matches: (methodName: string) => boolean
  load: () => Promise<readonly RpcAnyMethodDeclaration[]>
}

function matchesAnyPrefix(methodName: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => methodName.startsWith(prefix))
}

/** Lightweight RPC methods needed immediately during desktop/orcad startup. */
export const STARTUP_RPC_METHODS: readonly RpcAnyMethodDeclaration[] = [
  ...STATUS_METHODS,
  ...DESKTOP_WINDOW_METHODS,
  ...HOST_CAPABILITY_METHODS,
  ...RUNTIME_CLIENT_CAPABILITY_METHODS,
  ...CLIENT_EVENT_METHODS,
  ...CLIENT_UI_METHODS,
  ...SESSION_TAB_METHODS,
  ...WORKSPACE_LAYOUT_METHODS,
  ...(ORCA_LAYOUT_OWNER_IS_MAIN ? [...LAYOUT_APPLY_METHODS, ...LAYOUT_VIEW_REPORT_METHODS] : []),
  ...(ORCA_SIDEBAR_INPUTS_IS_MAIN ? SIDEBAR_INPUT_METHODS : []),
  ...SIDEBAR_REPO_ICON_METHODS,
  ...TERMINAL_METHODS,
  ...TERMINAL_DAEMON_METHODS,
  ...REPO_METHODS,
  ...WORKTREE_METHODS,
  ...AGENT_HOOK_METHODS,
  ...AGENT_ACTIVITY_METHODS,
  ...NOTIFICATION_METHODS,
  ...PREFLIGHT_METHODS,
  ...WORKSPACE_PORT_METHODS,
  ...FILE_METHODS,
  ...GIT_METHODS,
  ...CLIPBOARD_METHODS,
  ...UPDATER_METHODS,
  ...ORCA_ACCOUNT_METHODS
]

/** Heavy non-startup RPC method groups loaded on first dispatch so Main avoids eager module + Zod schema graphs. */
export const LAZY_RPC_METHOD_GROUPS: readonly LazyRpcMethodGroup[] = [
  {
    matches: (name) =>
      name === 'worktree.releaseBotHome' ||
      matchesAnyPrefix(name, [
        'bot.',
        'bots.',
        'botGroup.',
        'botGroups.',
        'webhook.',
        'webhooks.',
        'googleSetup.',
        'connector.',
        'connectors.'
      ]),
    load: async () => {
      const [bots, connectors, slackMirror] = await Promise.all([
        import('./bot-rpc-methods'),
        import('./connectors/connector'),
        import('./connectors/connector-slack-mirror')
      ])
      return [
        ...bots.BOT_RPC_METHODS,
        ...connectors.CONNECTOR_METHODS,
        ...slackMirror.CONNECTOR_SLACK_MIRROR_METHODS
      ]
    }
  },
  {
    matches: (name) => matchesAnyPrefix(name, ['browser.', 'desktopBrowserBridge.']),
    load: async () => (await import('./browser-rpc-methods')).BROWSER_RPC_METHODS
  },
  {
    matches: (name) => name.startsWith('google.'),
    load: async () => {
      const [g, gr, gf, gw] = await Promise.all([
        import('./google'),
        import('./google-read'),
        import('./google-files'),
        import('./google-write')
      ])
      return [
        ...g.GOOGLE_METHODS,
        ...gr.GOOGLE_READ_METHODS,
        ...gf.GOOGLE_FILES_METHODS,
        ...gw.GOOGLE_WRITE_METHODS
      ]
    }
  },
  {
    matches: (name) => name.startsWith('emulator.'),
    load: async () => (await import('./emulator/emulator')).EMULATOR_METHODS
  },
  {
    matches: (name) => name.startsWith('speech.'),
    load: async () => (await import('./speech/speech')).SPEECH_METHODS
  },
  {
    matches: (name) =>
      matchesAnyPrefix(name, [
        'linear.',
        'jira.',
        'gitlab.',
        'github.',
        'hostedReview.',
        'review.'
      ]),
    load: async () => {
      const [linear, linearAgent, jira, gitlab, github, review] = await Promise.all([
        import('./integrations/linear/linear'),
        import('./integrations/linear/linear-agent-access'),
        import('./integrations/jira/jira'),
        import('./source-control/gitlab/gitlab'),
        import('./source-control/github/github'),
        import('./source-control/reviews/hosted-review')
      ])
      return [
        ...linear.LINEAR_METHODS,
        ...linearAgent.LINEAR_AGENT_ACCESS_METHODS,
        ...jira.JIRA_METHODS,
        ...gitlab.GITLAB_METHODS,
        ...github.GITHUB_METHODS,
        ...review.HOSTED_REVIEW_METHODS
      ]
    }
  },
  {
    matches: (name) =>
      matchesAnyPrefix(name, [
        'nativeChat.',
        'structuredAgentSession.',
        'agentSession.',
        'agentConversation.',
        'aiVault.',
        'artifact.'
      ]),
    load: async () => {
      const [nc, sas, att, vis, ag, conv, vault, art, termAgent] = await Promise.all([
        import('./native-chat/native-chat'),
        import('./structured-sessions/structured-agent-session'),
        import('./structured-sessions/attachments/structured-agent-session-attachments'),
        import('./structured-sessions/attachments/structured-agent-session-visual'),
        import('./structured-sessions/catalog/structured-agent-session-agents'),
        import('./agent-conversations/agent-conversation-methods'),
        import('./history/ai-vault'),
        import('./artifacts/artifacts'),
        import('./terminal/agent-session')
      ])
      return [
        ...nc.NATIVE_CHAT_METHODS,
        ...sas.STRUCTURED_AGENT_SESSION_METHODS,
        ...att.STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS,
        ...vis.STRUCTURED_AGENT_SESSION_VISUAL_METHODS,
        ...ag.STRUCTURED_AGENT_SESSION_AGENTS_METHODS,
        ...conv.AGENT_CONVERSATION_METHODS,
        ...vault.AI_VAULT_METHODS,
        ...art.ARTIFACT_METHODS,
        ...termAgent.AGENT_SESSION_METHODS
      ]
    }
  },
  {
    matches: (name) => matchesAnyPrefix(name, ['pairing.', 'mobile.', 'mobileRelay.']),
    load: async () => {
      const [pairing, relay, sections, web] = await Promise.all([
        import('./pairing/pairing'),
        import('./pairing/mobile-relay-hosts'),
        import('./mobile-delivery/mobile-project-sections'),
        import('./mobile-delivery/mobile-web-bundle')
      ])
      return [
        ...pairing.PAIRING_METHODS,
        ...relay.MOBILE_RELAY_HOSTS_METHODS,
        ...sections.MOBILE_PROJECT_SECTIONS_METHODS,
        ...web.MOBILE_WEB_BUNDLE_METHODS
      ]
    }
  },
  {
    matches: (name) =>
      matchesAnyPrefix(name, [
        'orcad.',
        'managedServer.',
        'environmentDoctor.',
        'recipeVm.',
        'managedRuntime.'
      ]),
    load: async () => {
      const [mig, cen, ms, doc, vm, rt] = await Promise.all([
        import('./orcad/orcad-migration'),
        import('./orcad/orcad-terminal-census'),
        import('./host-management/managed-server'),
        import('./host-management/environment-doctor'),
        import('./host-management/recipe-vm-wake'),
        import('./host-management/managed-runtime-install')
      ])
      return [
        ...mig.ORCAD_MIGRATION_METHODS,
        ...cen.ORCAD_TERMINAL_CENSUS_METHODS,
        ...ms.MANAGED_SERVER_METHODS,
        ...doc.ENVIRONMENT_DOCTOR_METHODS,
        ...vm.RECIPE_VM_WAKE_METHODS,
        ...rt.MANAGED_RUNTIME_INSTALL_METHODS
      ]
    }
  },
  {
    // Catch-all fallback ensures any remaining or newly added method still resolves cleanly.
    matches: () => true,
    load: async () => (await import('./rpc-method-registry')).ALL_RPC_METHODS
  }
]

export const DEFAULT_RPC_DISPATCHER_METHODS = {
  methods: STARTUP_RPC_METHODS,
  lazyMethodLoaders: LAZY_RPC_METHOD_GROUPS
} as const
