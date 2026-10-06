// Extracts an explicit credential home from a command for a host-detected CLI.
import { posix } from 'node:path'
import { tokenizeCustomCommandTemplate } from '../../shared/commit-message-prompt'

export type ProfileCommandContext = {
  commandName: string
  executable: string
  homeVariable: string
  hostHome: string
  platform?: NodeJS.Platform
}

export type ProfileCommandDiscovery =
  | { kind: 'resolved'; executable: string; home: string; homeVariable: string }
  | { kind: 'needs-path'; reason: string }

export function parseProfileCommand(
  input: string,
  context: ProfileCommandContext
): ProfileCommandDiscovery {
  const platform = context.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    return { kind: 'needs-path', reason: 'unsupported-platform' }
  }
  if (
    input.length > 4096 ||
    [...input].some(
      (char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || (/\s/.test(char) && char !== ' ')
    )
  ) {
    return { kind: 'needs-path', reason: 'unsupported-command' }
  }
  const parsed = tokenizeCustomCommandTemplate(input)
  if (!parsed.ok || parsed.tokens.length !== 2 || !posix.isAbsolute(context.executable)) {
    return { kind: 'needs-path', reason: 'unsupported-command' }
  }
  const [assignment, executable] = parsed.tokens
  const rawExecutable = input.slice(parsed.spans[1].start, parsed.spans[1].end)
  const prefix = `${context.homeVariable}=`
  if (
    !assignment.startsWith(prefix) ||
    (executable !== context.commandName && executable !== context.executable) ||
    parsed.spans[1].divergesFromShell ||
    !isLiteralExecutable(rawExecutable)
  ) {
    return { kind: 'needs-path', reason: 'unsupported-command' }
  }
  // Keep the original quotes: '$HOME' is literal, while "$HOME" expands.
  const rawAssignment = input.slice(parsed.spans[0].start, parsed.spans[0].end)
  const home = parseHomeValue(rawAssignment.slice(prefix.length), context.hostHome)
  if (!home) {
    return { kind: 'needs-path', reason: 'unresolved-home' }
  }
  return {
    kind: 'resolved',
    executable: context.executable,
    home,
    homeVariable: context.homeVariable
  }
}

function isLiteralExecutable(raw: string): boolean {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return !raw.slice(1, -1).includes("'")
  }
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return !/["$`\\]/.test(raw.slice(1, -1))
  }
  return !/[\s'"$`\\*?[\]{}~;&|<>()]/.test(raw)
}

function parseHomeValue(raw: string, hostHome: string): string | null {
  const quote = raw[0] === '"' || raw[0] === "'" ? raw[0] : null
  if (quote && (raw.at(-1) !== quote || raw.slice(1, -1).includes(quote))) {
    return null
  }
  let value = quote ? raw.slice(1, -1) : raw
  // Backslash and mixed-quote forms need a full shell grammar; use folder selection.
  if (
    value.includes('\\') ||
    (!quote && value.includes(':~')) ||
    (!quote && /[\s'";&|<>`(){}*?[\]]/.test(value.replace(/^\$\{HOME\}(?=\/|$)/, '')))
  ) {
    return null
  }
  if (quote !== "'") {
    if (value.includes('`')) {
      return null
    }
    const homePrefix = value.match(/^(\$HOME|\$\{HOME\})(?=\/|$)/)?.[0]
    const tildePrefix = !quote && (value === '~' || value.startsWith('~/')) ? '~' : null
    const expansion = homePrefix ?? tildePrefix
    if (expansion) {
      if (!posix.isAbsolute(hostHome) || value.slice(expansion.length).includes('$')) {
        return null
      }
      // Preserve /link/.. until realpath: lexical normalization can select another home.
      value = hostHome + value.slice(expansion.length)
    } else if (value.includes('$')) {
      return null
    }
  }
  return posix.isAbsolute(value) ? value : null
}
