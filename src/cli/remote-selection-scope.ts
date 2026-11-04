/** Commands that act only on this machine: dispatch ignores --environment / --pairing-code for them, and help does not offer them. */
export function ignoresRemoteSelection(commandPath: readonly string[]): boolean {
  return (
    // add signs in on this machine; list and select are plain RPCs a paired server can answer.
    (commandPath[0] === 'account' && !['list', 'select'].includes(commandPath[1] ?? '')) ||
    commandPath[0] === 'artifacts' ||
    commandPath[0] === 'environment' ||
    // Paired servers come from the local store; routing SSH lookup would mix two machines in one list.
    commandPath.join(' ') === 'host list' ||
    commandPath[0] === 'serve' ||
    (commandPath[0] === 'agent' && commandPath[1] !== 'launch') ||
    commandPath[0] === 'vm' ||
    commandPath[0] === 'agent-context' ||
    commandPath[0] === 'profile' ||
    // Authoring works on local files; the handler refuses explicit remote flags.
    (commandPath[0] === 'plugin' &&
      ['create', 'validate', 'inspect'].includes(commandPath[1] ?? ''))
  )
}
