import type { AcpLaunchSpec } from './acp-launch-contract'

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
