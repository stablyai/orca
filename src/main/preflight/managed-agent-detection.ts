// Orca's own installed copies of agent CLIs count as installed agents on this host. The runtime
// that installs them says which, so detection stays free of the installers' dependencies.

let installedManagedAgents: () => Promise<readonly string[]> = async () => []
let managedAgentCommand: (agent: string) => Promise<string | null> = async () => null

export function provideInstalledManagedAgents(
  read: () => Promise<readonly string[]>,
  command?: (agent: string) => Promise<string | null>
): void {
  installedManagedAgents = read
  managedAgentCommand = command ?? (async () => null)
}

/** The agents whose Orca copy is installed here and may run; never blocks on the disk. */
export function readInstalledManagedAgents(): Promise<readonly string[]> {
  return installedManagedAgents()
}

/** The full path of Orca's installed copy of `agent`, once its release has been read; else null. */
export function readManagedAgentCommand(agent: string): Promise<string | null> {
  return managedAgentCommand(agent)
}
