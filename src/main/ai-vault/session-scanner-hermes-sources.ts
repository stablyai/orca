import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverFiles } from './session-scanner-discovery'
import { listHermesSqliteSessionsViaWorker } from './session-scanner-opencode-sqlite-worker-spawn'
import type { AiVaultScanOptions, SessionFileDiscovery } from './session-scanner-types'

const DEFAULT_HERMES_HOME = process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes')

type HermesSource = {
  profileName: string
  sessionsDir: string
  dbPaths: readonly string[]
  reportMissingDb: boolean
}

export function hermesDiscoveries(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  limit: number,
  issues: AiVaultScanIssue[]
): Promise<SessionFileDiscovery>[] {
  // Why: the global cap must be applied after Hermes legacy/SQLite candidates
  // are canonicalized; limiting either source here can hide the next unique row.
  void limit
  return hermesSources(options, wslHomeDirs).map((source) =>
    discoverHermesSource({ ...source, issues })
  )
}

function hermesSources(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): HermesSource[] {
  if (options.hermesDbPath || options.hermesDbPaths !== undefined) {
    const dbPaths = options.hermesDbPath ? [options.hermesDbPath] : (options.hermesDbPaths ?? [])
    const profileName =
      options.hermesProfileName?.trim() || inferProfileName(dbPaths[0]) || 'default'
    return [
      {
        profileName,
        sessionsDir:
          options.hermesSessionsDir ??
          join(dbPaths[0] ? dirname(dbPaths[0]) : DEFAULT_HERMES_HOME, 'sessions'),
        dbPaths,
        reportMissingDb: options.hermesDbPath !== undefined
      }
    ]
  }

  const home = options.hermesHomeDir ?? DEFAULT_HERMES_HOME
  const layout = normalizeHermesHome(home)
  const baseHome = layout.baseHome
  const sources: HermesSource[] = [
    {
      profileName: 'default',
      sessionsDir: options.hermesSessionsDir ?? join(baseHome, 'sessions'),
      dbPaths: [join(baseHome, 'state.db')],
      reportMissingDb: options.hermesHomeDir !== undefined && layout.directProfileName === null
    }
  ]
  if (!options.hermesHomeDir && !options.hermesSessionsDir) {
    for (const homeDir of wslHomeDirs) {
      sources.push({
        profileName: 'default',
        sessionsDir: join(homeDir, '.hermes', 'sessions'),
        dbPaths: [join(homeDir, '.hermes', 'state.db')],
        reportMissingDb: false
      })
    }
  }

  for (const profileDir of namedProfileDirs(baseHome)) {
    sources.push({
      profileName: profileDir.name,
      sessionsDir: join(profileDir.path, 'sessions'),
      dbPaths: [join(profileDir.path, 'state.db')],
      reportMissingDb:
        options.hermesHomeDir !== undefined && profileDir.name === layout.directProfileName
    })
  }
  const seenDbPaths = new Set<string>()
  return sources.map((source) => ({
    ...source,
    dbPaths: source.dbPaths.filter((dbPath) => {
      const key = resolve(dbPath)
      if (seenDbPaths.has(key)) {
        return false
      }
      seenDbPaths.add(key)
      return true
    })
  }))
}

function normalizeHermesHome(home: string): { baseHome: string; directProfileName: string | null } {
  const resolvedHome = resolve(home)
  const profilesRoot = dirname(resolvedHome)
  if (basename(profilesRoot) === 'profiles' && basename(resolvedHome)) {
    return { baseHome: dirname(profilesRoot), directProfileName: basename(resolvedHome) }
  }
  return { baseHome: resolvedHome, directProfileName: null }
}

function namedProfileDirs(home: string): { name: string; path: string }[] {
  const profilesRoot = join(home, 'profiles')
  if (!existsSync(profilesRoot)) {
    return []
  }
  return readdirSync(profilesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name))
    .map((entry) => ({ name: entry.name, path: join(profilesRoot, entry.name) }))
}

async function discoverHermesSource(
  args: HermesSource & {
    limit?: number
    issues: AiVaultScanIssue[]
  }
): Promise<SessionFileDiscovery> {
  const existingDbPaths = args.dbPaths.filter((path) => existsSync(path))
  if (args.reportMissingDb) {
    for (const dbPath of args.dbPaths) {
      if (!existsSync(dbPath)) {
        args.issues.push({
          agent: 'hermes',
          path: dbPath,
          message: 'Hermes state.db does not exist; legacy history was still scanned.'
        })
      }
    }
  }
  const [legacy, database] = await Promise.all([
    discoverFiles({
      rootDir: args.sessionsDir,
      limit: args.limit,
      agent: 'hermes',
      issues: args.issues,
      extensions: ['.json'],
      filePredicate: (path) => path.split(/[\\/]/).some((part) => part.startsWith('session_'))
    }),
    listHermesSqliteSessionsViaWorker({
      dbPaths: existingDbPaths,
      limit: args.limit,
      profileNames: existingDbPaths.map(() => args.profileName),
      issues: args.issues
    })
  ])
  const profileNamesByFilePath = Object.fromEntries(
    database
      .filter((candidate) => candidate.profileName)
      .map((candidate) => [candidate.file.path, candidate.profileName as string])
  )
  return {
    agent: 'hermes',
    rootDir: legacy.rootDir,
    profileName: args.profileName,
    profileNamesByFilePath,
    files: [...legacy.files, ...database.map((candidate) => candidate.file)]
  }
}

function inferProfileName(dbPath: string | undefined): string | null {
  if (!dbPath) {
    return null
  }
  const parts = dbPath.split(/[\\/]/)
  const profilesIndex = parts.lastIndexOf('profiles')
  if (profilesIndex >= 0 && parts[profilesIndex + 1]) {
    return parts[profilesIndex + 1] ?? null
  }
  return 'default'
}
