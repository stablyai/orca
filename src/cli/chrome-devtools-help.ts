export function formatChromeDevtoolsFlagHelp(command: string, flag: string): string | undefined {
  if (command === 'chrome-devtools call' && flag === 'tool') {
    return '--tool <name>          Exact tool name returned by chrome-devtools tools'
  }
  if (command === 'chrome-devtools call' && flag === 'arguments-file') {
    return '--arguments-file <path> JSON object containing the tool arguments'
  }
  if (command.startsWith('agent chrome-devtools ') && flag === 'agent') {
    return '--agent <id>           Config target: codex, opencode, gemini, pi, or all (required)'
  }
  if (command === 'agent chrome-devtools setup' && flag === 'dry-run') {
    return '--dry-run              Validate and preview without changing canonical config'
  }
  return undefined
}
