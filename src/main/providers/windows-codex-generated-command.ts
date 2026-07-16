function quoteGeneratedPowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Parse only the byte-for-byte command shape emitted by Orca's PowerShell planner. */
export function parseGeneratedPowerShellCodexCommand(command: string): string[] | null {
  if (command === 'codex') {
    return []
  }
  if (!command.startsWith('codex ')) {
    return null
  }

  let index = 'codex '.length
  const args: string[] = []
  while (index < command.length) {
    if (command[index] !== "'") {
      return null
    }
    index += 1
    let value = ''
    let closed = false
    while (index < command.length) {
      const char = command[index]
      if (char !== "'") {
        value += char
        index += 1
        continue
      }
      if (command[index + 1] === "'") {
        value += "'"
        index += 2
        continue
      }
      index += 1
      closed = true
      break
    }
    if (!closed || value.includes('\0')) {
      return null
    }
    args.push(value)
    if (index === command.length) {
      break
    }
    if (command[index] !== ' ') {
      return null
    }
    index += 1
  }

  const canonical = ['codex', ...args.map(quoteGeneratedPowerShellArg)].join(' ')
  return command === canonical ? args : null
}
