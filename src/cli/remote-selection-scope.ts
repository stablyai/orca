/** Commands that act only on this machine: dispatch ignores --environment / --pairing-code for them, and help does not offer them. */
export function ignoresRemoteSelection(commandPath: readonly string[]): boolean {
  return (
    commandPath[0] === 'account' ||
    commandPath[0] === 'artifacts' ||
    commandPath[0] === 'environment' ||
    // Paired servers come from the local store; routing SSH lookup would mix two machines in one list.
    commandPath.join(' ') === 'host list' ||
    // Removes ids that `host list` printed from this runtime; an ambient selection must not retarget it.
    commandPath.join(' ') === 'host rm' ||
    commandPath[0] === 'serve' ||
    (commandPath[0] === 'agent' && commandPath[1] !== 'launch') ||
    commandPath[0] === 'vm' ||
    // Providers belong to this computer's Orca app; an ambient --environment must not retarget them.
    commandPath[0] === 'provider' ||
    commandPath[0] === 'agent-context' ||
    commandPath[0] === 'profile' ||
    // Authoring works on local files; the handler refuses explicit remote flags.
    (commandPath[0] === 'plugin' &&
      ['create', 'validate', 'inspect'].includes(commandPath[1] ?? ''))
  )
}
