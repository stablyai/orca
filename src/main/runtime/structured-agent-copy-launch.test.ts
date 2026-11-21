import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session/journal/agent-session-journal-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import { agentSessionRecordFixture } from '../native-chat/testing/agent-session-record-test-fixture'
import { createClaudeStructuredLaunchResolver } from './agent-session/launch/structured-agent-launch-composition.test-support'
import { applyAgentCopy } from '../../shared/agent-launch/catalog/agent-copies'
import { structuredAgentLaunchEnv } from './agent-session/environment/structured-agent-launch-env'
import { structuredAgentConfiguredArgs } from '../native-chat/agent-launch/structured-agent-configured-args'
import { resolveStructuredAgentCommand } from '../native-chat/agent-launch/structured-agent-command-resolution'
import {
  installedManagedAgentCommand,
  rememberManagedAgentRelease
} from '../managed-agent-cli/managed-agent-cli-registry'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'chat',
  workspaceId: 'workspace-1',
  hostId: LOCAL_EXECUTION_HOST_ID,
  agent: 'claude',
  providerHandle: null
}

function launch(agentCopy?: string) {
  const record = agentSessionRecordFixture({
    sessionId: 'chat',
    ...(agentCopy ? { agentCopy } : {})
  })
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveCommand: () => ({ command: '/usr/local/bin/claude', prefixArgs: [] }),
    resolveAuthPolicy: () => ({ account: 'system' }),
    resolveLaunchArgs: () => ['--from-settings'],
    hasTranscript: async () => false,
    resolveAgentCopyLaunch: (agent, copyId) =>
      agent === 'claude' && copyId === 'claude.code-mode'
        ? {
            launchEnv: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' },
            commandSettings: { agentCmdOverrides: { claude: '/opt/copy/claude' } },
            launchArgs: ['--model', 'haiku'],
            resolveCommand: () => ({ command: '/opt/copy/claude', prefixArgs: [] })
          }
        : null
  })({ identity, permissionMode: 'full-access' })
}

describe('a chat that runs as an agent copy', () => {
  it("starts with the copy's command, arguments and environment", async () => {
    const copied = await launch('claude.code-mode')
    expect(copied.pathToClaudeCodeExecutable).toBe('/opt/copy/claude')
    expect(copied.options.extraArgs?.model).toBe('haiku')
    expect(copied.options.extraArgs).not.toHaveProperty('from-settings')
    expect(copied.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE).toBe('1')
  })

  it("keeps the agent's own setup for a chat without a copy", async () => {
    const plain = await launch()
    expect(plain.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude')
    expect(plain.options.extraArgs).toHaveProperty('from-settings')
  })

  it('refuses when the copy is gone instead of starting the agent', async () => {
    await expect(launch('claude.gone')).rejects.toThrow('Unknown agent copy "claude.gone"')
  })
})

describe.skipIf(process.platform === 'win32')(
  'a copy chat on a chat-only install, with no Claude CLI on this host',
  () => {
    afterEach(() => rememberManagedAgentRelease('claude', null))

    it("runs Orca's own Claude with the copy's arguments and environment", async () => {
      rememberManagedAgentRelease('claude', '/orca-data/agent-runtimes/claude/2.1.0')
      const copy = {
        id: 'claude.code-mode',
        name: 'Code mode',
        agent: 'claude' as const,
        args: '--model haiku',
        env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' }
      }
      const settings = {
        agentCmdOverrides: {},
        agentDefaultArgs: { claude: '--verbose' },
        agentDefaultEnv: {},
        agentCopies: [copy]
      }
      // The same pieces the runtime host builds for a copy, with nothing named claude on PATH.
      const copied = applyAgentCopy(settings, copy)
      const record = agentSessionRecordFixture({ sessionId: 'chat', agentCopy: copy.id })
      const launched = await createClaudeStructuredLaunchResolver({
        store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
        resolveCommand: () => {
          throw new Error('the base agent is never resolved for a copy chat')
        },
        resolveAuthPolicy: () => ({ account: 'system' }),
        resolveLaunchArgs: () => ['--from-settings'],
        hasTranscript: async () => false,
        resolveAgentCopyLaunch: (agent, copyId) =>
          agent === 'claude' && copyId === copy.id
            ? {
                launchEnv: structuredAgentLaunchEnv('claude', copied, {}),
                commandSettings: copied,
                launchArgs: structuredAgentConfiguredArgs('claude', copied),
                resolveCommand: (options) =>
                  resolveStructuredAgentCommand(
                    'claude',
                    copied,
                    { ...options, pathEnv: '' },
                    { resolve: (name) => name }
                  )
              }
            : null
      })({ identity, permissionMode: 'full-access' })
      expect(installedManagedAgentCommand('claude')).toBeTruthy()
      expect(launched.pathToClaudeCodeExecutable).toBe(installedManagedAgentCommand('claude'))
      expect(launched.options.extraArgs?.model).toBe('haiku')
      expect(launched.options.extraArgs).not.toHaveProperty('verbose')
      expect(launched.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE).toBe('1')
    })
  }
)
