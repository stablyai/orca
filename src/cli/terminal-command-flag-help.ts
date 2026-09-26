/** Per-flag help for terminal verbs; orchestration --terminal stays handle-only. */
export function formatTerminalCommandFlagHelp(
  commandPath: readonly string[],
  flag: string
): string | undefined {
  const command = commandPath.join(' ')
  if (commandPath[0] === 'terminal' && flag === 'terminal') {
    return '--terminal <selector> Runtime handle or stable pty:<ptyId> from terminal list'
  }
  if (command === 'terminal close' && flag === 'tab') {
    return '--tab                  Close the whole tab and wait for durable persistence'
  }
  return undefined
}
