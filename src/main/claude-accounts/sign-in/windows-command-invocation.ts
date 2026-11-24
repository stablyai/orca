export type WindowsCommandInvocation = {
  command: string
  args: string[]
  windowsVerbatimArguments: true
}

function quoteCmdToken(value: string): string {
  if (/[\r\n"]/.test(value)) {
    throw new Error('Windows command tokens cannot contain quotes or line breaks.')
  }
  const crtEscaped = value.replace(
    /(\\*)$/,
    (_match, backslashes: string) => `${backslashes}${backslashes}`
  )
  // Percent expansion still runs inside quotes, so briefly leave the quoted span to escape it.
  return `"${crtEscaped.replace(/%/g, '"^%"')}"`
}

export function buildWindowsCommandInvocation(
  command: string,
  args: string[],
  commandInterpreter = process.env.ComSpec ?? 'cmd.exe'
): WindowsCommandInvocation {
  const commandLine = [command, ...args].map(quoteCmdToken).join(' ')
  return {
    command: commandInterpreter,
    args: ['/d', '/v:off', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true
  }
}
