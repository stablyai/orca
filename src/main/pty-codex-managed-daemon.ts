/** Only detached, explicitly managed Codex services outlive their launching terminal. */
export function isCodexManagedDaemon(command: string | undefined): boolean {
  const match = command?.match(/^(?:\/\S*\/)?codex\s+app-server\s+(.+)$/)
  if (!match) {
    return false
  }
  const args = match[1].trim().split(/\s+/)
  return (
    args.join(' ') === 'daemon pid-update-loop' ||
    (args[0]?.startsWith('--') === true && args.includes('--managed-daemon'))
  )
}
