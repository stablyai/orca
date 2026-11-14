// Apply fallback only to host refusals; transport messages, including empty ones, must pass through verbatim.
export function refusedRpcMessageOrFallback(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : '') || fallback
}

// Catch interpretation only so transport rejection retains its original identity and delivery-unknown mark.
export function interpretOrThrowRefusalMessage<T>(interpret: () => T, fallback: string): T {
  try {
    return interpret()
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, fallback))
  }
}

// Treat non-string host errors as absent so display consumers never call string methods on malformed values.
export function hostReplyErrorTextOrFallback(value: unknown, fallback: string): string {
  return (typeof value === 'string' ? value : '') || fallback
}
