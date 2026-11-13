// EP-8: lets the cloud pairing recovery hear that a server refused this computer's pairing, without
// the transport depending on cloud workspaces. Observing only: the failure still reaches its caller.

type Observer = (
  environmentId: string,
  error: { code: string | undefined; message: string }
) => void

let observer: Observer | null = null

export function setRuntimeEnvironmentRejectionObserver(next: Observer | null): void {
  observer = next
}

/** A call or subscription to this environment failed; the observer decides whether it was a refusal. */
export function noteRuntimeEnvironmentFailure(environmentId: string, error: unknown): void {
  if (!observer || !(error instanceof Error) || error.name === 'AbortError') {
    return
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined
  try {
    observer(environmentId, { code, message: error.message })
  } catch {
    // Never let the observer change the failure the caller sees.
  }
}
