import { isHostNotConnectedError } from '../../query/host-query-errors'
import { optionalSettingsRead } from '../../settings/mobile-settings-read-operations'
import type { RpcAcceptedResult } from '../../transport/rpc/rpc-accepted-result'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import '../../worktree/worktree-host-context-labels'
import { buildHostLabelById } from '../../../../src/shared/worktree/row-display/host-context-labels'
import { hostSshTargetSummariesRead } from '../host-screen-operations'

export async function settledMetadataReply(
  send: () => Promise<RpcResponse>
): Promise<RpcResponse | null> {
  try {
    return await send()
  } catch (error) {
    // A query read sent while the host is down is not an answer; the connected edge reads it again.
    if (isHostNotConnectedError(error)) {
      throw error
    }
    // Best-effort: hosts that predate a method still list repos; labels degrade to host ids.
    return null
  }
}

export function acceptedMetadata<Value>(
  reply: RpcResponse | null,
  interpret: (reply: RpcResponse) => RpcAcceptedResult<Value>
): Value | null {
  if (!reply) {
    return null
  }
  const verdict = interpret(reply)
  return verdict.accepted ? verdict.value : null
}

function readHostSettingOverrides(result: unknown): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return (result as { hostSettingOverrides?: unknown } | null)?.hostSettingOverrides
}

export async function readHostSshTargetLabels(client: RpcClient) {
  const [sshTargets, hostSettings] = await Promise.all([
    settledMetadataReply(() => hostSshTargetSummariesRead.request(client)),
    settledMetadataReply(() => optionalSettingsRead.request(client))
  ])
  const hostSettingsResult = hostSettings ? optionalSettingsRead.interpret(hostSettings) : null
  const sshTargetSummaries =
    acceptedMetadata(sshTargets, hostSshTargetSummariesRead.interpret) ?? []
  return {
    sshTargetSummaries,
    hostLabelById: buildHostLabelById({
      sshTargets: sshTargetSummaries,
      hostSettingOverrides: readHostSettingOverrides(
        hostSettingsResult?.accepted ? hostSettingsResult.value : undefined
      )
    })
  }
}
