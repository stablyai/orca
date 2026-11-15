/** Per fallback shell; translated in main because the terminal daemon has no UI language. */
export type WindowsPwshNotFoundNotices = {
  windowsPowerShell: string
  commandPrompt: string
}

export function buildWindowsPwshNotFoundNotices(
  translate: (key: string, fallback: string) => string = (_key, fallback) => fallback
): WindowsPwshNotFoundNotices {
  return {
    windowsPowerShell: translate(
      'terminal.windowsPwshNotFound.windowsPowerShell',
      'Orca could not find PowerShell 7 (pwsh.exe), so this terminal opened Windows PowerShell instead.'
    ),
    commandPrompt: translate(
      'terminal.windowsPwshNotFound.commandPrompt',
      'Orca could not find PowerShell 7 (pwsh.exe), so this terminal opened Command Prompt instead.'
    )
  }
}
