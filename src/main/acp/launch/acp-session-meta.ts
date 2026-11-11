import type { AcpLaunchSpec } from './acp-launch-contract'

export function acpSessionStartMeta(
  spec: AcpLaunchSpec,
  extra?: Readonly<Record<string, unknown>>
): { _meta: Readonly<Record<string, unknown>> } | Record<never, never> {
  return spec.sessionMeta || extra ? { _meta: { ...spec.sessionMeta, ...extra } } : {}
}
