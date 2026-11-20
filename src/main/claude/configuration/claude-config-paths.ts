import { posix, win32 } from 'node:path'

export type ClaudeTrustPathStyle = 'posix' | 'win32'

type ClaudeGlobalConfigLocation = {
  env: { CLAUDE_CONFIG_DIR?: string; CLAUDE_CODE_CUSTOM_OAUTH_URL?: string }
  homeDir: string
  style: ClaudeTrustPathStyle
}

function pathApi(style: ClaudeTrustPathStyle): typeof posix {
  return style === 'win32' ? win32 : posix
}

/** Claude looks up NFC `path.normalize` output, with `/` separators on Windows. */
export function toClaudeTrustKey(folderPath: string, style: ClaudeTrustPathStyle): string {
  const normalized = pathApi(style).normalize(folderPath.normalize('NFC'))
  return style === 'win32' ? normalized.replaceAll('\\', '/') : normalized
}

export function claudeGlobalConfigCandidates(args: ClaudeGlobalConfigLocation): {
  legacyFile: string
  currentFile: string
} {
  const { join } = pathApi(args.style)
  const legacyDir = (args.env.CLAUDE_CONFIG_DIR ?? join(args.homeDir, '.claude')).normalize('NFC')
  const suffix = args.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : ''
  return {
    legacyFile: join(legacyDir, '.config.json'),
    currentFile: join(args.env.CLAUDE_CONFIG_DIR || args.homeDir, `.claude${suffix}.json`)
  }
}

/** Claude prefers legacy .config.json, then .claude.json under CLAUDE_CONFIG_DIR or home. */
export function resolveClaudeGlobalConfigFile(
  args: ClaudeGlobalConfigLocation & { exists: (filePath: string) => boolean }
): string {
  const { legacyFile, currentFile } = claudeGlobalConfigCandidates(args)
  return args.exists(legacyFile) ? legacyFile : currentFile
}
