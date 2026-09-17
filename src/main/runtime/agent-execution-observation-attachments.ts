import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { parseAppSshPtyId } from '../providers/ssh-pty-id'
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import type { AgentExecutionAttachment } from '../../shared/agent-execution-observation'
import { makePaneKey } from '../../shared/stable-pane-id'

type HostOwnership = ReadonlyMap<string, string | null>
type PtyIncarnations = ReadonlyMap<string, string>

/**
 * Derives observation attachments only from committed owner and process indexes.
 * Missing host or incarnation ownership is intentionally omitted rather than
 * guessed as local or inferred from a spawn operation.
 */
export function buildAgentExecutionAttachments(
  owners: readonly AgentSessionOwnerBinding[],
  options: {
    ptyOwnership: HostOwnership
    ptyIncarnationById: PtyIncarnations
    getHostEpoch: (hostId: ExecutionHostId) => string
  }
): AgentExecutionAttachment[] {
  const attachments: AgentExecutionAttachment[] = []
  for (const owner of owners) {
    const connectionId = options.ptyOwnership.get(owner.ptyId)
    const incarnationId = options.ptyIncarnationById.get(owner.ptyId)
    const parsedSshPty = connectionId === undefined ? parseAppSshPtyId(owner.ptyId) : null
    const hostId =
      connectionId === undefined
        ? parsedSshPty
          ? toSshExecutionHostId(parsedSshPty.connectionId)
          : null
        : connectionId === null
          ? LOCAL_EXECUTION_HOST_ID
          : toSshExecutionHostId(connectionId)
    if (!hostId) {
      continue
    }
    const paneKey = makePaneKey(owner.surface.tabId, owner.surface.leafId)
    attachments.push({
      executionId: owner.statusBinding.attachment.executionId,
      runId: owner.statusBinding.runId,
      role: owner.statusBinding.role,
      ...(owner.statusBinding.continuityOf
        ? { continuityOf: owner.statusBinding.continuityOf }
        : {}),
      hostId,
      paneKey,
      hostEpoch: options.getHostEpoch(hostId),
      ...(incarnationId
        ? {
            processIncarnation: `${owner.ptyId}:${incarnationId}`,
            processId: owner.ptyId,
            processIncarnationId: incarnationId
          }
        : {})
    })
  }
  return attachments
}
