// Literal unquoted in cmd.exe, and not a PowerShell token boundary.
const WINDOWS_BARE_SAFE = /^[A-Za-z0-9._:/@\\~*?!=+-]$/

export function quoteCliCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (process.platform === 'win32') {
    return quoteWindowsCliArgument(value)
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

function quoteWindowsCliArgument(value: string): string {
  // No `$`: keep the historical double-quoted Windows spelling.
  if (!value.includes('$')) {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  const first = value[0] ?? ''
  const dotSource = first === '.' && (value[1] === '$' || value[1] === '"' || value[1] === "'")
  // Why: `"`, `@`, and a dot-source `.` end the PowerShell token before the rest.
  if (dotSource || first === '@' || (first !== '$' && !WINDOWS_BARE_SAFE.test(first))) {
    return `"${value.replace(/[`$"]/g, (char) => `\`${char}`)}"`
  }
  // Why `$"x"`: PowerShell expands `$` only when a variable name follows, and
  // cmd concatenates a quoted character onto the surrounding text.
  let quoted = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] ?? ''
    if (char === '$') {
      const next = value[index + 1]
      if (next && isPowerShellVariableStart(next)) {
        let run = next
        index += 2
        while (
          index < value.length &&
          value[index] !== '$' &&
          !WINDOWS_BARE_SAFE.test(value[index] ?? '')
        ) {
          run += value[index]
          index += 1
        }
        index -= 1
        // Why: `$"r""'"` is one quoted run, so the `""` becomes a literal quote.
        quoted += `$${quoteWindowsRun(run)}`
        continue
      }
      quoted += '$'
      continue
    }
    if (WINDOWS_BARE_SAFE.test(char)) {
      quoted += char
      continue
    }
    let run = ''
    while (
      index < value.length &&
      value[index] !== '$' &&
      !WINDOWS_BARE_SAFE.test(value[index] ?? '')
    ) {
      run += value[index]
      index += 1
    }
    index -= 1
    // Why: a `\` left outside the quotes is doubled for cmd and kept by PowerShell.
    const slashes = quoted.match(/\\+$/)
    if (slashes) {
      quoted = quoted.slice(0, -slashes[0].length)
      run = `${slashes[0]}${run}`
    }
    quoted += quoteWindowsRun(run)
  }
  return quoted
}

function quoteWindowsRun(run: string): string {
  return `"${escapeWindowsQuotedRun(run)}"`
}

function escapeWindowsQuotedRun(run: string): string {
  let escaped = ''
  for (let index = 0; index < run.length; index += 1) {
    const char = run[index] ?? ''
    const next = run[index + 1]
    if (char === '"') {
      escaped += '""'
      continue
    }
    if (char === '`') {
      escaped += '``'
      continue
    }
    // Why: `"$()"` is a PowerShell subexpression. A final `$` is already literal.
    if (char === '$' && next && (next === '(' || next === '{' || isPowerShellVariableStart(next))) {
      escaped += '`$'
      continue
    }
    escaped += char
  }
  return escaped
}

function isPowerShellVariableStart(char: string): boolean {
  // Mirrors PowerShell VarNameFirst, plus other letters and digits.
  return /^[A-Za-z0-9_?$^:]$/.test(char) || /[\p{L}\p{N}]/u.test(char)
}
