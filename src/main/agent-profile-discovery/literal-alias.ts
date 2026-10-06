// Reads only literal alias declarations; the caller supplies bounded candidate file text.
import {
  parseProfileCommand,
  type ProfileCommandContext,
  type ProfileCommandDiscovery
} from './command'

export type ProfileAliasSource = { name: string; content: string }
export type ProfileAliasDiscovery = ProfileCommandDiscovery & { source?: string }

export function discoverLiteralProfileAlias(
  name: string,
  sources: readonly ProfileAliasSource[],
  context: ProfileCommandContext
): ProfileAliasDiscovery {
  const fallback: ProfileAliasDiscovery = { kind: 'needs-path', reason: 'unresolved-alias' }
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || sources.length > 4) {
    return fallback
  }
  let candidate: { command: string; source: string } | undefined
  for (const source of sources) {
    if (Buffer.byteLength(source.content, 'utf8') > 1024 * 1024 || source.content.includes('\r')) {
      return fallback
    }
    for (const raw of source.content.split('\n')) {
      const line = raw.replace(/^[ \t]+/, '')
      if (!line || line.startsWith('#')) {
        continue
      }
      // A match inside a function, conditional or heredoc is not a proven definition.
      const declaration = line.match(/^alias[ \t]+([A-Za-z0-9_.-]+)='([^']*)'(?:[ \t]+#.*)?[ \t]*$/)
      if (!declaration || declaration[1] === context.commandName || declaration[1] === 'alias') {
        return fallback
      }
      if (declaration[1] === name) {
        if (candidate) {
          return fallback
        }
        candidate = { command: declaration[2], source: source.name }
      }
    }
  }
  if (!candidate) {
    return fallback
  }
  const parsed = parseProfileCommand(candidate.command, context)
  return parsed.kind === 'resolved' ? { ...parsed, source: candidate.source } : parsed
}
