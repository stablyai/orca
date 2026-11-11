export function parseShellArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === ' ' && !inDouble && !inSingle) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (current) {
    args.push(current)
  }
  return args
}

export function stripAgentBrowserTargetArgs(args: string[]): string[] {
  const stripped: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--cdp' || arg === '--session') {
      index++
      continue
    }
    if (arg.startsWith('--cdp=') || arg.startsWith('--session=')) {
      continue
    }
    stripped.push(arg)
  }
  return stripped
}
