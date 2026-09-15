// Mirrors the ACP host's POSIX `shlex.split` so tests can exercise the exec path (#16087).
// Throws on malformed input like shlex does, so a broken quoting change fails loudly here.
export function shlexSplit(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (char === '\\' && quote !== "'") {
      const next = command[index + 1]
      if (next === undefined) {
        throw new Error(`shlexSplit: trailing backslash with nothing to escape: ${command}`)
      }
      current += next
      started = true
      index += 1
      continue
    }
    if (quote === null && (char === '"' || char === "'")) {
      quote = char
      started = true
      continue
    }
    if (quote === char) {
      quote = null
      continue
    }
    if (quote === null && /\s/.test(char)) {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (quote !== null) {
    throw new Error(`shlexSplit: unbalanced ${quote} quote: ${command}`)
  }
  if (started) {
    tokens.push(current)
  }
  return tokens
}

// Unwrap the `/bin/sh -c` payload so assertions match the snippet, not its escaping.
export function posixHookInnerCommand(command: string): string {
  const argv = shlexSplit(command)
  return argv[0] === '/bin/sh' && argv[1] === '-c' && argv[2] !== undefined ? argv[2] : command
}
