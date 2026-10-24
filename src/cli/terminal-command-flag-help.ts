/** Per-flag help for terminal commands, kept out of the shared help chain it would crowd. */

export function formatTerminalCommandFlagHelp(command: string, flag: string): string | undefined {
  if (command === 'terminal close' && flag === 'tab') {
    return '--tab                  Close the whole tab and wait for durable persistence'
  }
  if (command === 'terminal send' && flag === 'text') {
    return "--text <text>          Raw PTY bytes without --enter. Bash/Zsh ANSI-C: $'\\x1b' Escape, $'\\x15' Ctrl+U"
  }
  if (command === 'terminal send' && flag === 'interrupt') {
    return '--interrupt            Append Ctrl+C (\\x03); other control sequences use --text'
  }
  return undefined
}
