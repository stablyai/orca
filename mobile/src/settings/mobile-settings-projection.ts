import '../transport/rpc/rpc-operation'
import '../../../src/shared/source-control/listing/source-control-group-order'

export function settingsMember(raw: unknown): unknown {
  const boxed: { readonly settings?: unknown } | null | undefined = raw == null ? raw : Object(raw)
  // Preserve the native engine's existing property-read exception on null/undefined.
  return boxed!.settings
}

// Box primitives so a non-object settings value reads as absent instead of throwing.
export function settingsField(settings: unknown, key: string): unknown {
  const boxed: Record<string, unknown> = Object(settings)
  return boxed[key]
}
