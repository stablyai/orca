import { optionalSettingsRead } from '../transport/settings-read-operations'
import type { RpcAcceptedResult } from '../transport/rpc-accepted-result'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { buildHostLabelById } from '../worktree/worktree-host-context-labels'
import { hostSshTargetSummariesRead } from './host-screen-operations'

export async function settledMetadataReply(
  send: () => Promise<RpcResponse>
): Promise<RpcResponse | null> {
  try {
    return await send()
  } catch {
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
    optionalSettingsRead.request(client).catch(() => null)
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
