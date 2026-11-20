// Orca's own installed copies of agent CLIs count as installed agents on this host. The runtime
// that installs them says which, so detection stays free of the installers' dependencies.

let installedManagedAgents: () => Promise<readonly string[]> = async () => []

export function provideInstalledManagedAgents(read: () => Promise<readonly string[]>): void {
  installedManagedAgents = read
}

/** The agents whose Orca copy is installed here and may run; never blocks on the disk. */
export function readInstalledManagedAgents(): Promise<readonly string[]> {
  return installedManagedAgents()
}
