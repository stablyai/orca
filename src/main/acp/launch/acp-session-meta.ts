import type { AcpLaunchSpec } from './acp-launch-contract'

/** Resolve optional provider `_meta` for `session/new`, `session/load`, and `session/resume`. */
export async function resolveAcpSessionStartMeta(
  spec: Pick<AcpLaunchSpec, 'sessionMeta'>,
  input: { cwd: string; env: Readonly<Record<string, string>> }
): Promise<{ _meta: Readonly<Record<string, unknown>> } | Record<never, never>> {
  try {
    const meta = await spec.sessionMeta?.(input)
    return meta ? { _meta: meta } : {}
  } catch {
    return {}
  }
}
