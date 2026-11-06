import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionProviderHandle } from '../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AiVaultAgent } from '../../shared/ai-vault/contracts/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand
} from '../../shared/ai-vault/resume/ai-vault-resume-command'
import { buildAgentResumeStartupPlan } from '../../shared/agent-launch/startup/tui-agent-resume-startup'
import { isResumableTuiAgent } from '../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStartupShell } from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { assertLegacyAiVaultResumeCommandAllowed } from './structured-session-ownership'
import { installOwnership } from './structured-session-ownership.test-support'

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
    handle: {
      transport: 'jsonl-rpc',
      agent: 'pi',
      nativeId: SESSION_FILE('.pi')
    }
  }
]

afterEach(() => setStructuredAgentSessionHost(null))

// Shared desktop/mobile resume builders must produce commands the ownership guard recognizes.
describe('resume commands Orca builds for an owned row', () => {
  const shells: { platform: NodeJS.Platform; shell: AgentStartupShell }[] = [
    { platform: 'darwin', shell: 'posix' },
    { platform: 'win32', shell: 'powershell' },
    { platform: 'win32', shell: 'cmd' }
  ]
  const overrides = (binary: string): Record<AgentStartupShell, (string | undefined)[]> => ({
    posix: [undefined, `FOO=1 /opt/bin/${binary}`, `env -i FOO=1 /opt/bin/${binary}`],
    powershell: [undefined, `& 'C:\\Program Files\\${binary}\\${binary}.exe'`],
    cmd: [undefined, `"C:\\Program Files\\${binary}\\${binary}.exe"`]
  })

  function builtCommands(conversation: OwnedConversation, fork = false): string[] {
    const agent = conversation.rowAgent
    if (!isResumableTuiAgent(agent)) {
      return []
    }
    return shells.flatMap(({ platform, shell }) => {
      const vault = fork
        ? null
        : buildAiVaultResumeCommand({
            agent,
            sessionId: conversation.sessionId,
            cwd: '/Users/me/repo',
            platform,
            shell,
            resumeFilePath: conversation.filePath
          })
      const tabs = overrides(agent)[shell].map((override) => {
        const plan = buildAgentResumeStartupPlan({
          agent,
          providerSession: {
            key: 'session_id',
            id: conversation.sessionId,
            transcriptPath: conversation.filePath
          },
          cmdOverrides: override ? { [agent]: override } : {},
          platform,
          shell,
          ompResumeFilePath: conversation.filePath,
          fork
        })
        return plan
          ? buildAiVaultResumeShellCommand({
              resumeCommand: plan.launchCommand,
              cwd: '/Users/me/repo',
              platform,
              shell
            })
          : null
      })
      return [vault, ...tabs].filter((command): command is string => command !== null)
    })
  }

  const everyAgent: OwnedConversation[] = [
    ...CONVERSATIONS,
    {
      rowAgent: 'claude',
      sessionId: UUID,
      filePath: `/Users/me/.claude/projects/-Users-me-repo/${UUID}.jsonl`,
      handle: claudeProviderHandle(UUID, null)
    },
    {
      rowAgent: 'codex',
      sessionId: UUID,
      filePath: `/Users/me/.codex/sessions/2026/10/09/rollout-2026-10-09T10-00-00-${UUID}.jsonl`,
      handle: codexProviderHandle(UUID)
    }
  ]

  it.each(everyAgent)('refuses each one for the $rowAgent row', async (conversation) => {
    installOwnership({ handle: conversation.handle })
    const commands = builtCommands(conversation)
    expect(commands.length).toBe(10)
    for (const command of commands) {
      await expect(
        assertLegacyAiVaultResumeCommandAllowed(command, async () => undefined),
        command
      ).rejects.toThrow('agent_session_conflict')
    }
  })
})
