import { isServerManagementCommand } from './local-environment-selector'

/** Commands that act only on this computer: dispatch ignores --server / --pairing-code for them, and help does not offer them. */
export function ignoresRemoteSelection(commandPath: readonly string[]): boolean {
  return (
    commandPath[0] === 'account' ||
    commandPath[0] === 'artifacts' ||
    isServerManagementCommand(commandPath) ||
    // Saved servers come from the local store; routing SSH lookup would mix two computers in one list.
    commandPath.join(' ') === 'host list' ||
    // Removes ids that `host list` printed from this Orca; an ambient selection must not retarget it.
    commandPath.join(' ') === 'host rm' ||
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
