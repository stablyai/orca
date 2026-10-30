import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { StructuredAgentSessionResumeSource } from '../../shared/structured-agent-session-create'
import type { StructuredAgentId } from '../../shared/agent-session-provider-handle'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import {
  adoptsCliConversations,
  chatAgentsShareConversations,
  CLI_CONVERSATION_ADOPTING_AGENTS
} from '../../shared/structured-agent-cli-conversation-adoption'
import { isWslUncPath } from '../../shared/wsl-paths'
import { needsWslHostResolution } from './host-readable-transcript-path'
import { parseSshTranscriptPath } from './ssh-transcript-path'

type CliSource = NonNullable<StructuredAgentSessionResumeSource['cliSource']>
export type StructuredAgentCliSourceRoute = 'native-local' | 'unsupported' | 'unknown'
export type StructuredAgentCliSourceLocator =
  | { kind: 'none' }
  | { kind: 'matched'; transcriptPath?: string }
  | { kind: 'absent' }

export type StructuredAgentCliSourceEvidence = (
  | { readonly rows: readonly Readonly<AgentStatusIpcPayload>[] }
  | { readonly error: unknown }
) & {
  readonly sourceRoute?: Readonly<CliSource & { route: StructuredAgentCliSourceRoute }>
  readonly routeError?: unknown
}

export function captureStructuredAgentCliSource(
  readRows: () => readonly AgentStatusIpcPayload[],
  source?: CliSource,
  readRoute?: (source: CliSource) => StructuredAgentCliSourceRoute
): StructuredAgentCliSourceEvidence {
  let rows: StructuredAgentCliSourceEvidence
  try {
    rows = {
      rows: Object.freeze(
        readRows().map((row) =>
          Object.freeze({
            ...row,
            ...(row.providerSession
              ? { providerSession: Object.freeze({ ...row.providerSession }) }
              : {})
          })
        )
      )
    }
  } catch (error) {
    rows = { error }
  }
  if (!source || !readRoute) {
    return Object.freeze(rows)
  }
  try {
    return Object.freeze({
      ...rows,
      sourceRoute: Object.freeze({ ...source, route: readRoute(source) })
    })
  } catch (routeError) {
    return Object.freeze({ ...rows, routeError })
  }
}

export function structuredAgentCliSourceFromEvidence(input: {
  agent: StructuredAgentId
  resumeFrom: StructuredAgentSessionResumeSource
  workspaceId: string
  evidence?: StructuredAgentCliSourceEvidence
}): StructuredAgentCliSourceLocator {
  const evidence = input.evidence
  if (input.resumeFrom.cliSource && evidence && 'error' in evidence) {
    throw evidence.error
  }
  return resolveSource({
    ...input,
    rows: evidence && 'rows' in evidence ? evidence.rows : []
  })
}

/** Derive provider paths from host evidence; clients may name only panes. */
export function structuredAgentCliSourcePath(input: {
  agent: StructuredAgentId
  resumeFrom: StructuredAgentSessionResumeSource
  workspaceId: string
  rows: readonly AgentStatusIpcPayload[]
}): string | undefined {
  const source = resolveSource(input)
  return source.kind === 'matched' ? source.transcriptPath : undefined
}

function resolveSource(input: {
  agent: StructuredAgentId
  resumeFrom: StructuredAgentSessionResumeSource
  workspaceId: string
  rows: readonly AgentStatusIpcPayload[]
  evidence?: StructuredAgentCliSourceEvidence
}): StructuredAgentCliSourceLocator {
  const source = input.resumeFrom.cliSource
  if (!source) {
    return { kind: 'none' }
  }
  const row = input.rows.find(
    (candidate) =>
      source.workspaceId === input.workspaceId &&
      candidate.worktreeId === source.workspaceId &&
      candidate.paneKey === source.paneKey &&
      !candidate.connectionId &&
      !candidate.structuredHost &&
      adoptsCliConversations(candidate.agentType) &&
      // OpenCode 2 may report the legacy opencode name for the same conversation.
      CLI_CONVERSATION_ADOPTING_AGENTS[candidate.agentType].some((agent) =>
        chatAgentsShareConversations(agent, input.agent)
      ) &&
      candidate.providerSession?.id === input.resumeFrom.providerSessionId
  )
  if (!row) {
    if (
      source.workspaceId === input.workspaceId &&
      !input.rows.some((candidate) => candidate.paneKey === source.paneKey)
    ) {
      const evidence = input.evidence
      if (evidence && 'routeError' in evidence) {
        throw evidence.routeError
      }
      const route = evidence?.sourceRoute
      if (route?.workspaceId === source.workspaceId && route.paneKey === source.paneKey) {
        if (route.route === 'native-local') {
          return { kind: 'absent' }
        }
        if (route.route === 'unsupported') {
          throw agentSessionRefusalError('structured_agent_session_unsupported', {
            reason: 'hostUnsupported'
          })
        }
      }
    }
    throw agentSessionRefusalError(
      'agent_session_identity_required',
      { reason: 'transcriptUnreadable' },
      'The source conversation is no longer available.'
    )
  }
  const path = row.providerSession?.transcriptPath?.trim()
  if (
    path &&
    (isWslUncPath(path) || needsWslHostResolution(path) || parseSshTranscriptPath(path))
  ) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  return { kind: 'matched', ...(path ? { transcriptPath: path } : {}) }
}
