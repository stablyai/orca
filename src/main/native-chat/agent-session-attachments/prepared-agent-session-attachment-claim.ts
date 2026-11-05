import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionExpiredAttachment } from '../../../shared/agent-session/failures/agent-session-expired-attachments'
import { AGENT_SESSION_EXPIRED_ATTACHMENTS_MAX } from '../../../shared/agent-session/failures/agent-session-expired-attachments'
import {
  AGENT_SESSION_ATTACHMENT_PART_FILE,
  agentSessionAttachmentReferenceNames,
  agentSessionAttachmentReferences,
  agentSessionAttachmentStoreRoot
} from './agent-session-attachment-references'
import {
  AgentSessionAttachmentExpiredError,
  type AgentSessionAttachmentClaim
} from './agent-session-attachment-claims'

export type PreparedAgentSessionAttachmentClaim = {
  sessionId: string
  now: number
  uploadIds: Set<string>
  required: string[]
  names: AgentSessionExpiredAttachment[]
}

/** Host admission owns preparation through commit, excluding attachment sweep publication. */
export async function prepareAgentSessionAttachmentClaim(
  claim: AgentSessionAttachmentClaim
): Promise<PreparedAgentSessionAttachmentClaim> {
  const root = agentSessionAttachmentStoreRoot(claim.stateDirectory)
  const uploadIds = agentSessionAttachmentReferences(root, claim.body)
  const kept = claim.previous
    ? agentSessionAttachmentReferences(root, claim.previous)
    : new Set<string>()
  const required = claim.required ? [...uploadIds].filter((id) => !kept.has(id)) : []
  const expired: string[] = []
  for (const id of required) {
    const stored = await readdir(join(root, id)).then(
      (entries) => entries.some((entry) => entry !== AGENT_SESSION_ATTACHMENT_PART_FILE),
      () => false
    )
    if (!stored) {
      expired.push(id)
    }
  }
  if (expired.length > 0) {
    throw new AgentSessionAttachmentExpiredError(
      agentSessionAttachmentReferenceNames(
        root,
        claim.body,
        expired.slice(0, AGENT_SESSION_EXPIRED_ATTACHMENTS_MAX)
      )
    )
  }
  return {
    sessionId: claim.sessionId,
    now: claim.now,
    uploadIds,
    required,
    names: agentSessionAttachmentReferenceNames(root, claim.body, required)
  }
}
