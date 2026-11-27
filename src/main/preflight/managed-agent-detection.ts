// The runtime supplies installed chat copies without coupling their consumers to the installers.

let installedManagedAgents: () => Promise<readonly string[]> = async () => []
export function provideInstalledManagedAgents(read: () => Promise<readonly string[]>): void {
  installedManagedAgents = read
}

/** The agents whose Orca copy is installed here and may run; never blocks on the disk. */
export function readInstalledManagedAgents(): Promise<readonly string[]> {
  return installedManagedAgents()
}
