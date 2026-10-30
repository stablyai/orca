/** Commands that act only on this machine: dispatch ignores --environment / --pairing-code for them, and help does not offer them. */
export function ignoresRemoteSelection(commandPath: readonly string[]): boolean {
  return (
    commandPath[0] === 'account' ||
    commandPath[0] === 'artifacts' ||
    commandPath[0] === 'environment' ||
    // Paired servers come from the local store; routing SSH lookup would mix two machines in one list.
    commandPath.join(' ') === 'host list' ||
    commandPath[0] === 'serve' ||
    (commandPath[0] === 'agent' && commandPath[1] !== 'launch') ||
    commandPath[0] === 'vm' ||
    commandPath[0] === 'agent-context' ||
    commandPath[0] === 'profile'
  )
}
