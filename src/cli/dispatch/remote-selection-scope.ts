/** Commands that act only on this machine: dispatch ignores --environment / --pairing-code for them, and help does not offer them. */
export function ignoresRemoteSelection(commandPath: readonly string[]): boolean {
  return (
    commandPath[0] === 'account' ||
    commandPath[0] === 'auth' ||
    commandPath[0] === 'artifacts' ||
    commandPath[0] === 'environment' ||
    // Paired servers come from the local store; routing SSH lookup would mix two machines in one list.
    commandPath.join(' ') === 'host list' ||
    // Removes ids that `host list` printed from this runtime; an ambient selection must not retarget it.
    commandPath.join(' ') === 'host rm' ||
    commandPath[0] === 'serve' ||
    // `agent hooks` configures this machine; launch and the ID commands act on the selected host.
    (commandPath[0] === 'agent' && commandPath[1] === 'hooks') ||
    // The bridge reaches the Orca its entry pins; an agent's inherited selection must not reroute it.
    commandPath[0] === 'mcp' ||
    commandPath[0] === 'vm' ||
    commandPath[0] === 'agent-context' ||
    commandPath[0] === 'profile' ||
    // Authoring works on local files; the handler refuses explicit remote flags.
    (commandPath[0] === 'plugin' &&
      ['create', 'validate', 'inspect'].includes(commandPath[1] ?? '')) ||
    // Skill installs write this machine's agent folders; the handler refuses explicit remote flags.
    (commandPath[0] === 'skills' && ['install', 'update'].includes(commandPath[1] ?? ''))
  )
}
