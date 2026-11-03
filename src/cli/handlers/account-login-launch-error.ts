import {
  getSpawnArgsForWindows,
  WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL
} from '../../shared/windows-batch-spawn'

/** Names whether the launcher path or a login argument tripped the batch guard, without echoing argument values. */
export function describeUnsafeWindowsLoginLaunch(command: string, resolvedCommand: string): string {
  try {
    getSpawnArgsForWindows(resolvedCommand, [])
  } catch {
    return (
      `Cannot run \`${command}\` from "${resolvedCommand}": the path contains characters ` +
      `cmd.exe would reinterpret. Install it somewhere without ` +
      `${WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL} in the path.`
    )
  }
  return (
    `Cannot pass a login argument to the Windows batch launcher "${resolvedCommand}": ` +
    `an --integration, --method or --answer value contains ${WINDOWS_BATCH_UNSAFE_CHARACTERS_LABEL} ` +
    `or a line break. Leave that value out and answer the prompt in an interactive terminal.`
  )
}
