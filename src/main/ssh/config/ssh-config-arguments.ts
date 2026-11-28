/** Splits an ssh_config argument list the way OpenSSH argv_split does: '…' and "…" quote, \\ \" \' and unquoted "\ " escape. */
export function splitOpenSshArguments(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: string | null = null

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (char === '\\') {
      const next = input[index + 1]
      // Other backslashes, e.g. Windows path separators, stay literal.
      if (next === '"' || next === "'" || next === '\\' || (!quote && next === ' ')) {
        current += next
        index++
        continue
      }
    }

    if (quote ? char === quote : char === '"' || char === "'") {
      quote = quote ? null : char
      continue
    }

    // A # starts a comment only at a token boundary; `team#1` stays one argument.
    if (!quote && char === '#' && !current) {
      break
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) {
    args.push(current)
  }

  return args
}
