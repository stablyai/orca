// Orca's own installed copies of agent CLIs count as installed agents on this host. The runtime
// that installs them says which, so detection stays free of the installers' dependencies.

let installedManagedAgents: () => Promise<readonly string[]> = async () => []
let managedAgentCommand: (agent: string) => string | null = () => null

export function provideInstalledManagedAgents(
  read: () => Promise<readonly string[]>,
  command?: (agent: string) => string | null
): void {
  installedManagedAgents = read
  managedAgentCommand = command ?? (() => null)
}

/** The agents whose Orca copy is installed here and may run; never blocks on the disk. */
export function readInstalledManagedAgents(): Promise<readonly string[]> {
  return installedManagedAgents()
}

/** The full path of Orca's installed copy of `agent`; null until its release has been read. */
export function readManagedAgentCommand(agent: string): string | null {
  return managedAgentCommand(agent)
}
