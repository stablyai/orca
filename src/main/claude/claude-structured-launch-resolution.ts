import { createHash } from 'node:crypto'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveClaudeCommand } from '../codex-cli/command'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { getSpawnArgsForWindows } from '../win32-utils'

export const CLAUDE_DEFAULT_SETTING_SOURCES = ['user', 'project', 'local'] as const

export const CLAUDE_STRUCTURED_BASE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--replay-user-messages',
  '--permission-prompt-tool',
  'stdio',
  '--setting-sources',
  CLAUDE_DEFAULT_SETTING_SOURCES.join(',')
]

export type ClaudeStructuredLaunch = {
  command: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  claudeConfigDir: string
  providerSessionId: string
  resumeLeafUuid: string | null
  resumed: boolean
}

export type ClaudeStructuredLaunchResolverDeps = {
  store: AgentSessionRecordStore
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveCommand?: () => string
  resolveEnv?: () => Record<string, string>
}

export function claudeSessionIdForOrcaSession(sessionId: string): string {
  const bytes = createHash('sha256').update(`orca-claude:${sessionId}`).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createClaudeStructuredLaunchResolver(
  deps: ClaudeStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<ClaudeStructuredLaunch> {
  return async ({ identity }) => {
    const record = deps.store.getRecord(identity.sessionId)
    if (!record) {
      throw new Error(`no durable agent-session record for ${identity.sessionId}`)
    }
    if (record.provider !== 'claude') {
      throw new Error(`session ${identity.sessionId} is a ${record.provider} session`)
    }
    if (
      record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      record.location.wslDistro !== null
    ) {
      throw new Error(
        `claude structured sessions run on the local host, not ${record.location.executionHostId}`
      )
    }
    if (record.accountHome.variable !== 'CLAUDE_CONFIG_DIR') {
      throw new Error(`claude sessions pin CLAUDE_CONFIG_DIR, not ${record.accountHome.variable}`)
    }
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    const providerSessionId =
      head?.handle.provider === 'claude'
        ? head.handle.sessionId
        : claudeSessionIdForOrcaSession(identity.sessionId)
    const providerArgs =
      head?.handle.provider === 'claude'
        ? ['--resume', providerSessionId]
        : ['--session-id', providerSessionId]
    const command = (deps.resolveCommand ?? resolveClaudeCommand)()
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, [
      ...CLAUDE_STRUCTURED_BASE_ARGS,
      ...providerArgs
    ])
    return {
      command: spawnCmd,
      args: spawnArgs,
      cwd: await deps.resolveWorkspacePath(record.location.workspaceId),
      ...(record.launchEnv
        ? { env: { ...record.launchEnv } }
        : deps.resolveEnv
          ? { env: deps.resolveEnv() }
          : {}),
      claudeConfigDir: record.accountHome.path,
      providerSessionId,
      resumeLeafUuid: head?.handle.provider === 'claude' ? head.handle.leafUuid : null,
      resumed: head?.handle.provider === 'claude'
    }
  }
}
