// Why (#22434): every Orca agent hook script lives in Orca's `.orca/agent-hooks`
// directory, so that directory is Orca's one identity in any agent's hook file,
// including an entry another agent's importer copied across.
const ORCA_AGENT_HOOK_SCRIPT = /(?:^|[/'"\s=])\.orca\/agent-hooks\/[^/'"\s]+/

export function isOrcaAgentHookCommand(command: string | undefined): boolean {
  if (!command) {
    return false
  }
  const decodedCommand = decodePowerShellEncodedCommand(command)
  const searchText = decodedCommand ? `${command}\n${decodedCommand}` : command
  return ORCA_AGENT_HOOK_SCRIPT.test(searchText.replaceAll('\\', '/'))
}

export function decodePowerShellEncodedCommand(command: string): string | null {
  const match = command.match(/\s-EncodedCommand\s+(\S+)/i)
  if (!match) {
    return null
  }
  try {
    return Buffer.from(match[1], 'base64').toString('utf16le')
  } catch {
    return null
  }
}
