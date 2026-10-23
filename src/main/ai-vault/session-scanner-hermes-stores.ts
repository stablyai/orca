import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { resolveHermesHomeDir } from '../../shared/hermes-home'
import { hermesSessionSourceFromFilePath } from '../../shared/hermes-session-source'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  wslGatedAccess,
  wslGatedLstat,
  wslGatedReaddir,
  wslGatedStat
} from '../native-chat/wsl-transcript-fs-access'
import type { AiVaultScanOptions } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'

const MAX_PROFILE_STORES = 256
const MAX_PROFILE_DIRECTORIES = 4096
const PROFILE_MARKERS = ['state.db', 'config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json']

function uniqueHomes(homes: readonly string[]): string[] {
  const seen = new Set<string>()
  return homes.filter((home) => {
    const key =
      process.platform === 'win32' && !/^\\\\wsl[.$]/i.test(home)
        ? win32.normalize(home).toLowerCase()
        : home
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export function hermesHostHomes(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[]
): string[] {
  if (options.hermesSessionsDir) {
    return [dirname(options.hermesSessionsDir)]
  }
  const effective = resolveHermesHomeDir()
  const root =
    hermesSessionSourceFromFilePath(`${join(effective, 'state.db')}#root`)?.rootDir ?? effective
  return uniqueHomes([
    root,
    join(homedir(), '.hermes'),
    ...wslHomeDirs.map((home) => join(home, '.hermes'))
  ])
}

function missing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

async function profileHomes(
  home: string,
  issues: AiVaultScanIssue[],
  signal?: AbortSignal
): Promise<string[]> {
  const profiles = join(home, 'profiles')
  try {
    throwIfSignalAborted(signal)
    const entries = await wslGatedReaddir(profiles, 'scan', signal)
    const names = entries
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          entry.name !== 'default' &&
          /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.name)
      )
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const homes: string[] = []
    const inspect = names.slice(0, MAX_PROFILE_DIRECTORIES)
    for (let index = 0; index < inspect.length; index += 4) {
      const found = await mapWithConcurrency(inspect.slice(index, index + 4), 4, async (entry) => {
        const profile = join(profiles, entry.name)
        if (entry.isSymbolicLink()) {
          try {
            if (!(await wslGatedStat(profile, 'scan', signal)).isDirectory()) {
              return null
            }
          } catch (error) {
            throwIfSignalAborted(signal)
            if (!missing(error)) {
              issues.push({
                agent: 'hermes',
                kind: 'scope',
                path: profile,
                message: errorMessage(error)
              })
            }
            return null
          }
        }
        try {
          await wslGatedAccess(join(profiles, '.deleted', entry.name), 'scan', signal)
          return null
        } catch (error) {
          throwIfSignalAborted(signal)
          if (!missing(error)) {
            issues.push({
              agent: 'hermes',
              kind: 'scope',
              path: profile,
              message: errorMessage(error)
            })
            return null
          }
        }
        for (const marker of PROFILE_MARKERS) {
          try {
            const info = await wslGatedLstat(join(profile, marker), 'scan', signal)
            if (info.isFile() || info.isSymbolicLink()) {
              return profile
            }
          } catch (error) {
            throwIfSignalAborted(signal)
            if (!missing(error)) {
              issues.push({
                agent: 'hermes',
                kind: 'scope',
                path: profile,
                message: errorMessage(error)
              })
              return null
            }
          }
        }
        return null
      })
      const eligible = found.filter((profile): profile is string => profile !== null)
      const slots = MAX_PROFILE_STORES - homes.length
      homes.push(...eligible.slice(0, slots))
      if (homes.length >= MAX_PROFILE_STORES) {
        if (index + 4 < names.length || eligible.length > slots) {
          issues.push({
            agent: 'hermes',
            kind: 'scope',
            path: profiles,
            message: `Hermes profile discovery stopped at ${MAX_PROFILE_STORES} profiles.`
          })
        }
        break
      }
    }
    if (names.length > MAX_PROFILE_DIRECTORIES && homes.length < MAX_PROFILE_STORES) {
      issues.push({
        agent: 'hermes',
        kind: 'scope',
        path: profiles,
        message: `Hermes profile discovery stopped after ${MAX_PROFILE_DIRECTORIES} directory checks.`
      })
    }
    return homes
  } catch (error) {
    throwIfSignalAborted(signal)
    if (!missing(error)) {
      issues.push({ agent: 'hermes', kind: 'scope', path: profiles, message: errorMessage(error) })
    }
    return []
  }
}

export async function hermesStoreHomes(
  options: AiVaultScanOptions,
  wslHomeDirs: readonly string[],
  issues: AiVaultScanIssue[]
): Promise<string[]> {
  if (options.hermesStateDbPaths) {
    return uniqueHomes(options.hermesStateDbPaths.map(dirname))
  }
  const homes = hermesHostHomes(options, wslHomeDirs)
  const nested = await mapWithConcurrency(homes, 4, (home) =>
    profileHomes(home, issues, options.signal)
  )
  return uniqueHomes([...homes, ...nested.flat()])
}
