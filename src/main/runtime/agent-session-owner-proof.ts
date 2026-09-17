import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { proveAgentSessionOwner } from './agent-session-lease-transitions'
import { replaceAgentSessionRecordOptions } from './agent-session-record-options'

export type AgentSessionOwnerProofCommit = {
  sessionId: string
  fence: number
  link: AgentSessionProviderHandleLink
  now: number
  leaseTtlMs?: number
  options?: Readonly<Record<string, string>>
  permissionModeRestoreValue?: AgentSessionRecord['permissionModeRestoreValue']
}

export function commitAgentSessionOwnerProof(
  record: AgentSessionRecord,
  args: AgentSessionOwnerProofCommit,
  leaseTtlMs: number
): AgentSessionRecord {
  const proved = proveAgentSessionOwner({ ...args, record, leaseTtlMs })
  const withOptions = args.options
    ? replaceAgentSessionRecordOptions(proved, { ...args, options: args.options })
    : proved
  return args.permissionModeRestoreValue && !withOptions.permissionModeRestoreValue
    ? { ...withOptions, permissionModeRestoreValue: args.permissionModeRestoreValue }
    : withOptions
}
