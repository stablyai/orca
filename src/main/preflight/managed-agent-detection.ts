// Orca's own installed copies of agent CLIs count as installed agents on this host. The runtime
// that installs them says which, so detection stays free of the installers' dependencies.

let installedManagedAgents: () => readonly string[] = () => []
let held: PromiseWithResolvers<void> | null = null
// Bounds a startup that never reads its releases (it failed), so detection can't hang.
const HOLD_MS = 15_000

/** Detection waits for the runtime's first read of Orca's releases instead of caching none. */
export function holdInstalledManagedAgents(): void {
  held ??= Promise.withResolvers<void>()
}

export function provideInstalledManagedAgents(read: () => readonly string[]): void {
  installedManagedAgents = read
  held?.resolve()
}

/** The agents whose Orca copy is installed here and may run; read from memory, never the disk. */
export async function readInstalledManagedAgents(): Promise<readonly string[]> {
  if (held) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      held.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, HOLD_MS)
      })
    ])
    clearTimeout(timer)
    // Once waited out, later reads don't wait again.
    held = null
  }
  return installedManagedAgents()
}
