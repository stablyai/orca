// Orca's own installed copies of agent CLIs count as installed agents on this host. The runtime
// that installs them says which, so detection stays free of the installers' dependencies.

let installedManagedAgents: () => readonly string[] = () => []

export function provideInstalledManagedAgents(read: () => readonly string[]): void {
  installedManagedAgents = read
}

/** The agents whose Orca copy is installed here and may run; read from memory, never the disk. */
export function readInstalledManagedAgents(): readonly string[] {
  return installedManagedAgents()
}
