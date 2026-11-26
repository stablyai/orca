// What must run while a server pairing still holds its credential, just before a person removes it.
type BeforeRemoval = (environmentId: string) => Promise<void>

let beforeRemoval: BeforeRemoval | null = null

export function setBeforeRuntimeEnvironmentRemoval(hook: BeforeRemoval | null): void {
  beforeRemoval = hook
}

/** A failure is logged, never thrown: the person's removal goes ahead. */
export async function runBeforeRuntimeEnvironmentRemoval(environmentId: string): Promise<void> {
  try {
    await beforeRemoval?.(environmentId)
  } catch (error) {
    console.warn('[runtime-environments] Work before removing a server pairing failed:', error)
  }
}
