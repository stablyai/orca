export function notificationReplyInputIsEmpty(terminal: { draft?: string } | undefined): boolean {
  return terminal !== undefined && !terminal.draft?.trim()
}

export function notificationReplyTerminalClient(): { id: 'orca-cli'; type: 'desktop' } {
  return { id: 'orca-cli', type: 'desktop' }
}
