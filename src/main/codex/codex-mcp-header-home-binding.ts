import { posix, win32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { quoteWindowsCmdArgument } from '../../shared/child-process/windows-command-line'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'

function quoteRuntimeHome(runtimeHomePath: string): string {
  const home = parseWslUncPath(runtimeHomePath)?.linuxPath ?? runtimeHomePath
  const hasControl = [...home].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  if (hasControl || (!posix.isAbsolute(home) && !win32.isAbsolute(home))) {
    throw new Error('MCP header helper requires an absolute runtime home')
  }
  return posix.isAbsolute(home) ? quotePosixShell(home) : quoteWindowsCmdArgument(home)
}

function homeArgumentSpellings(home: string): string[] {
  if (win32.isAbsolute(home) && !posix.isAbsolute(home)) {
    return [quoteWindowsCmdArgument(home)]
  }
  const spellings = [quotePosixShell(home), `"${home.replace(/[\\$`"]/g, '\\$&')}"`]
  if (/^[A-Za-z0-9_./:-]+$/.test(home)) {
    spellings.push(home)
  }
  return spellings
}

function bindHomeArgument(
  command: string,
  sourceHomePath: string,
  runtimeHomePath: string
): string {
  const home = parseWslUncPath(sourceHomePath)?.linuxPath ?? sourceHomePath
  const spellings = homeArgumentSpellings(home)
  const windows = win32.isAbsolute(home) && !posix.isAbsolute(home)
  const executableStart = command.search(/\S/)
  let quote: string | null = null
  let atArgumentStart = true
  let result = ''
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? ''
    // Only whole literal arguments in the first simple command are path references.
    if (!quote && /[;|&<>`$#\r\n]/.test(char)) {
      return result + command.slice(index)
    }
    const match =
      !quote && atArgumentStart && index > executableStart
        ? spellings.find(
            (spelling) =>
              command.startsWith(spelling, index) &&
              (index + spelling.length === command.length ||
                /[ \t]/.test(command[index + spelling.length] ?? ''))
          )
        : undefined
    if (match) {
      result += quoteRuntimeHome(runtimeHomePath)
      index += match.length - 1
      atArgumentStart = false
    } else if (!windows && char === '\\' && quote !== "'") {
      result += char + (command[index + 1] ?? '')
      index += 1
      // Escaped whitespace belongs to this argument; it is not a token boundary.
      atArgumentStart = false
    } else {
      if (char === quote) {
        quote = null
      } else if (!quote && (char === '"' || (!windows && char === "'"))) {
        quote = char
      }
      result += char
      atArgumentStart = !quote && /[ \t]/.test(char)
    }
  }
  return result
}

function bindHelperLine(line: string, sourceHomePath: string, runtimeHomePath: string): string {
  const key = parseTomlKeyPath(line)
  if (
    !key ||
    key.segments.length !== 1 ||
    key.segments[0] !== 'http_headers_helper' ||
    line[key.end] !== '='
  ) {
    return line
  }
  const parsed = parseTomlSingleLineStringValue(line, key.end + 1)
  if (!parsed) {
    return line
  }
  const bound = bindHomeArgument(parsed.value, sourceHomePath, runtimeHomePath)
  return bound === parsed.value
    ? line
    : `${line.slice(0, parsed.start)}${JSON.stringify(bound)}${line.slice(parsed.end)}`
}

/** Rebase explicit home arguments only; never read credentials or infer a home from the environment. */
export function bindCodexMcpHeaderHelperHome(
  config: string,
  sourceHomePath: string,
  runtimeHomePath: string
): string {
  if (sourceHomePath === runtimeHomePath) {
    return config
  }
  const lines = config.split('\n')
  let mcpServerTable = false
  let state = createTomlLineScanState()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        const table = parseTomlTableHeaderPath(header)
        mcpServerTable =
          !!table &&
          !table.isArray &&
          table.segments.length === 2 &&
          table.segments[0] === 'mcp_servers'
      } else if (mcpServerTable) {
        lines[index] = bindHelperLine(line, sourceHomePath, runtimeHomePath)
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  return lines.join('\n')
}
