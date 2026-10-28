// cmd counts quotes naively and expands %VAR%; quoting must also survive CommandLineToArgvW.

// Doubled quotes decode literally while preserving cmd quote parity; backslashes still need doubling.
function quoteWindows(value: string, escapePercent: boolean): string {
  if (!(escapePercent ? /[\\"%]/ : /[\\"]/).test(value)) {
    return `"${value}"`
  }
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    if (char === '"') {
      quoted += `${'\\'.repeat(backslashes * 2)}""`
      backslashes = 0
      continue
    }
    if (escapePercent && char === '%') {
      // Break %VAR% expansion outside quotes; double backslashes before the inserted closing quote.
      quoted += `${'\\'.repeat(backslashes * 2)}"^%"`
      backslashes = 0
      continue
    }
    quoted += `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  // Double trailing backslashes so the closing quote cannot become escaped.
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** Uses CommandLineToArgvW quoting. */
export function quoteWindowsArgument(value: string): string {
  return quoteWindows(value, false)
}

// A separate function prevents Array.map indices from accidentally enabling percent escaping.
export function quoteWindowsCmdArgument(value: string): string {
  return quoteWindows(value, true)
}

/** Parses CommandLineToArgvW rules, including doubled quotes inside quoted runs. */
export function parseWindowsCommandLine(line: string): string[] {
  const argv: string[] = []
  let current = ''
  let quoted = false
  let started = false
  let index = 0
  while (index < line.length) {
    const char = line.charAt(index)
    if (!started && /[ \t]/.test(char)) {
      index += 1
      continue
    }
    started = true
    if (char === '\\') {
      let backslashes = 0
      while (line[index] === '\\') {
        backslashes += 1
        index += 1
      }
      if (line[index] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2))
        if (backslashes % 2 === 1) {
          current += '"'
          index += 1
        }
      } else {
        current += '\\'.repeat(backslashes)
      }
      continue
    }
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"'
        index += 2
        continue
      }
      quoted = !quoted
      index += 1
      continue
    }
    if (!quoted && /[ \t]/.test(char)) {
      argv.push(current)
      current = ''
      started = false
      index += 1
      continue
    }
    current += char
    index += 1
  }
  if (started) {
    argv.push(current)
  }
  return argv
}

/** Distinguishes cmd.exe line-break limits from agent failures. */
export class WindowsCmdLineBreakError extends Error {
  constructor() {
    super('cmd.exe cannot receive an argument containing a line break')
    this.name = 'WindowsCmdLineBreakError'
  }
}

export function validateWindowsCmdArguments(values: readonly string[]): void {
  for (const value of values) {
    // cmd ends a command at CR/LF regardless of quoting.
    if (/[\r\n]/.test(value)) {
      throw new WindowsCmdLineBreakError()
    }
  }
}

/** Requires windowsVerbatimArguments:true and shell:false to preserve quoting and windowsHide. */
export function buildWindowsCmdShimCommandLine(program: string, args: readonly string[]): string {
  validateWindowsCmdArguments([program, ...args])
  // Program paths can contain percent variables too.
  const inner = [program, ...args].map(quoteWindowsCmdArgument).join(' ')
  // Disable AutoRun and delayed expansion; /s strips only the outer quote pair.
  return `/d /v:off /s /c "${inner}"`
}

const CMD_INTERPRETED_EXTENSIONS = ['.cmd', '.bat']

export function isCmdInterpretedProgram(program: string): boolean {
  const lower = program.toLowerCase()
  return CMD_INTERPRETED_EXTENSIONS.some((extension) => lower.endsWith(extension))
}
