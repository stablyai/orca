export type WindowBounds = { width: number; height: number }

export function resolveWindowBounds({
  measured,
  fallback
}: {
  measured: WindowBounds | null
  fallback: WindowBounds
}): WindowBounds {
  return measured && measured.width > 0 && measured.height > 0 ? measured : fallback
}
