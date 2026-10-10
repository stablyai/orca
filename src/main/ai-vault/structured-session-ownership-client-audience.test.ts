import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import type { AiVaultAgent } from '../../shared/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand
} from '../../shared/ai-vault-resume-command'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-resume-startup'
import { isResumableTuiAgent } from '../../shared/agent-session-resume'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/electron-remote-runtime-client-capabilities'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { clientOpensStructuredChatFromHistory } from '../runtime/rpc/methods/structured-agent-session-policy'
import {
  assertLegacyAiVaultResumeCommandAllowed,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import { installOwnership, listResult } from './structured-session-ownership.test-support'

const UUID = '019fd622-3c4d-7e5f-a061-7c8d9e0f1a2b'
const OPENCODE_ID = 'ses_2f9aB3cD4eF5gH6iJ7kL8mN9oP'
const SESSION_FILE = (root: string) =>
  `/Users/me/${root}/agent/sessions/--Users-me-repo--/2026-10-09T10-00-00-000Z_${UUID}.jsonl`

type OwnedConversation = {
  rowAgent: AiVaultAgent
  sessionId: string
  filePath: string
  handle: AgentSessionProviderHandle
}

const CONVERSATIONS: OwnedConversation[] = [
  {
    rowAgent: 'opencode',
    sessionId: OPENCODE_ID,
    filePath: `/Users/me/.local/share/opencode/opencode.db#${OPENCODE_ID}`,
    handle: { transport: 'acp', agent: 'opencode', nativeId: OPENCODE_ID }
  },
  {
    rowAgent: 'opencode2',
    sessionId: OPENCODE_ID,
    filePath: `/Users/me/.local/share/opencode/opencode.db#${OPENCODE_ID}`,
    handle: { transport: 'acp', agent: 'opencode', nativeId: OPENCODE_ID }
  },
  {
    rowAgent: 'grok',
    sessionId: UUID,
    filePath: `/Users/me/.grok/sessions/%2FUsers%2Fme%2Frepo/${UUID}/summary.json`,
    handle: { transport: 'acp', agent: 'grok', nativeId: UUID }
  },
  {
    rowAgent: 'omp',
    sessionId: UUID,
    filePath: SESSION_FILE('.omp'),
    handle: { transport: 'acp', agent: 'omp', nativeId: UUID }
  },
  {
    rowAgent: 'pi',
    sessionId: UUID,
    filePath: SESSION_FILE('.pi'),
    handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: SESSION_FILE('.pi') }
  }
]

const OLD_MOBILE: RuntimeCapability[] = [
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
]
const NO_STRUCTURED_SESSIONS: RuntimeCapability[] = []
const CLIENTS = {
  'a client that renders only Claude and Codex chats (current mobile)': OLD_MOBILE,
  'a desktop paired to this host': [...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES],
  'a client that reads no structured sessions': NO_STRUCTURED_SESSIONS
}

function projectFor(conversation: OwnedConversation, clientCapabilities: RuntimeCapability[]) {
  const result = listResult()
  result.sessions = [
    { ...result.sessions[0]!, agent: conversation.rowAgent, ...conversation },
    { ...result.sessions[0]!, sessionId: 'unowned' }
  ]
  return projectStructuredAiVaultSessions(result, (agent) =>
    clientOpensStructuredChatFromHistory({ clientKind: 'mobile', clientCapabilities }, agent)
  ).sessions.map((row) => row.sessionId)
}

afterEach(() => setStructuredAgentSessionHost(null))

describe('Session History rows a paired client cannot open as a chat', () => {
  it.each(CONVERSATIONS)(
    'shows the $rowAgent row only to a client that renders its chat',
    (conversation) => {
      installOwnership({ handle: conversation.handle })
      const [oldMobile, desktop, legacy] = Object.values(CLIENTS)
      expect(projectFor(conversation, oldMobile!)).toEqual(['unowned'])
      expect(projectFor(conversation, desktop!)).toEqual([conversation.sessionId, 'unowned'])
      expect(projectFor(conversation, legacy!)).toEqual(['unowned'])
    }
  )

  it.each(Object.entries(CLIENTS))('keeps the Claude and Codex rule for %s', (_client, caps) => {
    for (const provider of ['claude', 'codex'] as const) {
      installOwnership({ provider })
      const result = listResult()
      result.sessions = result.sessions.map((row) => ({ ...row, agent: provider }))
      const owned = projectStructuredAiVaultSessions(result, (agent) =>
        clientOpensStructuredChatFromHistory(
          { clientKind: 'mobile', clientCapabilities: caps },
          agent
        )
      )
      // As before: every client that reads structured sessions gets the owned row.
      expect(owned.sessions.map((row) => row.structuredSession?.sessionId)).toEqual(
        caps.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) ? ['session-alpha'] : []
      )
    }
  })
})

// Orca's own resume builders and the guard's parser must agree, or a builder change lets a resume
// of a chat's conversation through. Mobile composes these same shared builders.
describe('resume commands Orca builds for an owned row', () => {
  const shells: { platform: NodeJS.Platform; shell: AgentStartupShell }[] = [
    { platform: 'darwin', shell: 'posix' },
    { platform: 'win32', shell: 'powershell' },
    { platform: 'win32', shell: 'cmd' }
  ]

  function builtCommands(conversation: OwnedConversation): string[] {
    const agent = conversation.rowAgent
    if (!isResumableTuiAgent(agent)) {
      return []
    }
    return shells.flatMap(({ platform, shell }) => {
      const vault = buildAiVaultResumeCommand({
        agent,
        sessionId: conversation.sessionId,
        cwd: '/Users/me/repo',
        platform,
        shell,
        resumeFilePath: conversation.filePath
      })
      const plan = buildAgentResumeStartupPlan({
        agent,
        providerSession: {
          key: 'session_id',
          id: conversation.sessionId,
          transcriptPath: conversation.filePath
        },
        cmdOverrides: {},
        platform,
        shell,
        ompResumeFilePath: conversation.filePath
      })
      const tab = plan
        ? buildAiVaultResumeShellCommand({
            resumeCommand: plan.launchCommand,
            cwd: '/Users/me/repo',
            platform,
            shell
          })
        : null
      return tab ? [vault, tab] : [vault]
    })
  }

  it.each(CONVERSATIONS)('refuses each one for the $rowAgent row', async (conversation) => {
    installOwnership({ handle: conversation.handle })
    const commands = builtCommands(conversation)
    expect(commands.length).toBe(shells.length * 2)
    for (const command of commands) {
      await expect(
        assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined),
        command
      ).rejects.toThrow('agent_session_conflict')
    }
  })
})
