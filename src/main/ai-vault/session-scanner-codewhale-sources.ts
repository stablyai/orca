import { existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

export type CodeWhaleSessionSource = {
  sessionsDir: string
  codeWhaleHome: string
}

type CodeWhaleSessionSourceContext = {
  codeWhaleHomeEnv?: string | null
  exists?: (path: string) => boolean
  homeDir?: string
}

export function codeWhaleDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  return resolveCodeWhaleSessionSources(options, wslHomeDirs).map((source) =>
    discoverCodeWhaleSessionFiles(source, limit, issues)
  )
}

export function resolveCodeWhaleSessionSources(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  context: CodeWhaleSessionSourceContext = {}
): CodeWhaleSessionSource[] {
  if (options.codeWhaleSessionsDir) {
    const sessionsDir = options.codeWhaleSessionsDir
    return uniqueSessionSources([
      {
        sessionsDir,
        codeWhaleHome: dirname(sessionsDir)
      }
    ])
  }

  const exists = context.exists ?? existsSync
  return uniqueSessionSources([
    ...localCodeWhaleSessionSources(context),
    ...wslHomeDirs.flatMap((homeDir): CodeWhaleSessionSource[] => [
      {
        sessionsDir: join(homeDir, '.codewhale', 'sessions'),
        codeWhaleHome: join(homeDir, '.codewhale')
      }
    ])
  ]).filter((source) => exists(source.sessionsDir))
}

async function discoverCodeWhaleSessionFiles(
  source: CodeWhaleSessionSource,
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery> {
  const discovery = await discoverFiles({
    rootDir: source.sessionsDir,
    limit,
    agent: 'codewhale',
    issues,
    extensions: ['.json'],
    // Why: CodeWhale stores per-session artifacts under sibling directories; only
    // top-level session JSON files are resumeable saved TUI sessions.
    filePredicate: (path) => dirname(path) === source.sessionsDir
  })
  return {
    ...discovery,
    codeWhaleHome: source.codeWhaleHome
  }
}

function localCodeWhaleSessionSources(
  context: CodeWhaleSessionSourceContext
): CodeWhaleSessionSource[] {
  const codeWhaleHomeSource = Object.hasOwn(context, 'codeWhaleHomeEnv')
    ? context.codeWhaleHomeEnv
    : process.env.CODEWHALE_HOME
  const codeWhaleHome = codeWhaleHomeSource?.trim()
  if (codeWhaleHome) {
    return [
      {
        sessionsDir: join(codeWhaleHome, 'sessions'),
        codeWhaleHome
      }
    ]
  }

  const home = context.homeDir ?? homedir()
  const primaryHome = join(home, '.codewhale')
  return [
    {
      sessionsDir: join(primaryHome, 'sessions'),
      codeWhaleHome: primaryHome
    }
  ]
}

function uniqueSessionSources(
  sources: readonly CodeWhaleSessionSource[]
): CodeWhaleSessionSource[] {
  const seen = new Set<string>()
  const unique: CodeWhaleSessionSource[] = []
  for (const source of sources) {
    const trimmedSessionsDir = source.sessionsDir.trim()
    if (!trimmedSessionsDir) {
      continue
    }
    const sessionsDir = join(trimmedSessionsDir, '.')
    if (seen.has(sessionsDir)) {
      continue
    }
    seen.add(sessionsDir)
    unique.push({
      sessionsDir,
      codeWhaleHome: source.codeWhaleHome
    })
  }
  return unique
}
