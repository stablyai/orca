import type { AcpLaunchSpec } from './acp-launch-contract'
import type { AcpInstructionsLaunch } from './acp-instructions'
import type { InitializeResponse } from '../generated/acp-protocol.generated'

export function acpSessionInstructionMeta(
  launch: Pick<AcpInstructionsLaunch, 'sessionMeta' | 'takesSessionMeta' | 'sessionMetaOptional'>,
  initialized: InitializeResponse,
  agentName: string
): Record<string, unknown> | undefined {
  const refused = Boolean(
    launch.sessionMeta && launch.takesSessionMeta && !launch.takesSessionMeta(initialized)
  )
  if (!refused) {
    return launch.sessionMeta
  }
  if (launch.sessionMetaOptional) {
    return undefined
  }
  const version = initialized.agentInfo?.version
  throw new Error(
    `${agentName}${version ? ` ${version}` : ''} cannot take this chat's standing instructions, so it did not start`
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function acpSessionStartMeta(
  spec: Pick<AcpLaunchSpec, 'sessionMeta'>,
  extra?: Readonly<Record<string, unknown>>
): { _meta?: Record<string, unknown> } {
  const meta = { ...spec.sessionMeta, ...extra }
  const base = spec.sessionMeta?.antigravity
  const added = extra?.antigravity
  if (record(base) && record(added)) {
    meta.antigravity = { ...base, ...added }
  }
  return Object.keys(meta).length ? { _meta: meta } : {}
}
