import { admitRelayOpenCodeTui } from './agent-hook-request'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import { isAgentHookSource, type AgentHookSource } from '../shared/agent-hook-relay'
import {
  buildSpoolHookBody,
  drainAgentHookSpool,
  type SpoolRecord
} from '../shared/agent-hook-spool'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'

export function ingestRelayHookSpoolRecord(
  record: SpoolRecord,
  state: HookListenerState,
  env: string,
  host: {
    apply: (
      event: AgentHookEventPayload,
      source: AgentHookSource,
      env?: string,
      version?: string
    ) => void
    isPaneSurfaceRetired: (paneKey: string) => boolean
    getAgentLaunchToken: (paneKey: string) => string | undefined
  }
): void {
  if (!isAgentHookSource(record.source)) {
    return
  }
  const body = buildSpoolHookBody(record)
  const event = normalizeHookPayload(state, record.source, body, env, {
    admitOpenCodeTui: (identity) => admitRelayOpenCodeTui(host, identity),
    deferCompactOwnershipToClient: true
  })
  if (event) {
    host.apply(event, record.source, hookBodyEnv(body), hookBodyVersion(body))
  }
}

export function drainRelayHookSpool(
  endpointDir: string,
  ingest: (record: SpoolRecord) => void
): void {
  try {
    drainAgentHookSpool({
      endpointDir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest
    })
  } catch (err) {
    // Why: a downstream relay failure must not prevent the loopback listener from starting;
    // the untruncated spool file remains available for retry on the next restart.
    process.stderr.write(
      `[relay-hook-server] spool replay failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }
}
