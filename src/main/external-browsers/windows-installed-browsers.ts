import { win32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expandWindowsEnvironmentVariables } from '../../shared/windows-environment-expansion'
import { getRegExePath } from '../win32-utils'
import type { DetectedBrowser } from './installed-browser-catalog'

// HKCU first so a per-user install wins over a machine-wide one with the same key.
const START_MENU_INTERNET_KEYS = [
  'HKCU\\SOFTWARE\\Clients\\StartMenuInternet',
  'HKLM\\SOFTWARE\\Clients\\StartMenuInternet',
  'HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet'
]
const REG_QUERY_TIMEOUT_MS = 5_000
const KEY_LINE = /^HKEY_[^\\]+\\.*?\\StartMenuInternet\\(.+?)\s*$/i
const VALUE_LINE = /^\s+(.+?)\s+REG_\w+(?:\s+(.*?))?\s*$/
// The default value's name is localized ("(Default)", "(Standard)"), so match it by shape.
const DEFAULT_VALUE_NAME = /^\(.*\)$/
const OPEN_COMMAND_SUBKEY = /^shell\\open\\command$/i

type BrowserRegistration = { id: string; name: string | null; command: string | null }

/** The executable from a `shell\open\command` value, dropping its arguments. */
export function parseWindowsBrowserExecutable(
  command: string,
  env: NodeJS.ProcessEnv
): string | null {
  const trimmed = command.trim()
  const executable = trimmed.startsWith('"')
    ? /^"([^"]+)"/.exec(trimmed)?.[1]
    : /^(.+?\.exe)(?=\s|$)/i.exec(trimmed)?.[1]
  if (!executable) {
    return null
  }
  const expanded = expandWindowsEnvironmentVariables(executable, env)
  return win32.isAbsolute(expanded) ? expanded : null
}

/** Parses one `reg query <StartMenuInternet> /s`; matched by shape, since names are localized. */
function parseStartMenuInternetRegistrations(output: string): BrowserRegistration[] {
  const registrations = new Map<string, BrowserRegistration>()
  let current: { registration: BrowserRegistration; subkey: string } | null = null
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      const path = KEY_LINE.exec(line)?.[1]
      if (!path) {
        current = null
        continue
      }
      const [id, ...subkeyParts] = path.split('\\')
      const key = id.toLowerCase()
      const registration = registrations.get(key) ?? { id, name: null, command: null }
      registrations.set(key, registration)
      current = { registration, subkey: subkeyParts.join('\\') }
      continue
    }
    const value = VALUE_LINE.exec(line)
    if (!current || !value || !DEFAULT_VALUE_NAME.test(value[1])) {
      continue
    }
    if (current.subkey === '') {
      current.registration.name = value[2] ?? null
    } else if (OPEN_COMMAND_SUBKEY.test(current.subkey)) {
      current.registration.command = value[2] ?? null
    }
  }
  return [...registrations.values()]
}

/** Outputs are in hive priority order; null marks a failed query. */
export function parseWindowsInstalledBrowsers(
  regQueryOutputs: readonly (string | null)[],
  env: NodeJS.ProcessEnv
): DetectedBrowser[] {
  const browsers = new Map<string, DetectedBrowser>()
  for (const output of regQueryOutputs) {
    for (const registration of output ? parseStartMenuInternetRegistrations(output) : []) {
      const key = registration.id.toLowerCase()
      const executable = registration.command
        ? parseWindowsBrowserExecutable(registration.command, env)
        : null
      if (browsers.has(key) || !executable) {
        continue
      }
      browsers.set(key, {
        id: registration.id,
        name: registration.name || registration.id,
        launchCommand: (url) => ({ program: executable, args: [url] })
      })
    }
  }
  return [...browsers.values()]
}

async function queryRegistryTree(key: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await runProcess({
      program: getRegExePath(env),
      args: ['query', key, '/s'],
      timeoutMs: REG_QUERY_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? result.stdout : null
  } catch {
    return null
  }
}

export async function readWindowsInstalledBrowsers(): Promise<DetectedBrowser[]> {
  const env = process.env
  const outputs = await Promise.all(
    START_MENU_INTERNET_KEYS.map((key) => queryRegistryTree(key, env))
  )
  return parseWindowsInstalledBrowsers(outputs, env)
}
