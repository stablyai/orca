import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { FactoryApiKeySource } from '../../shared/rate-limit-types'
import { readFactoryApiKey } from '../factory/factory-api-key-store'

export type FactoryApiKeyReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; apiKey: string; source: FactoryApiKeySource }

const FACTORY_ENV_FILE = join(homedir(), '.factory', '.env')

// Why: dotenv values may carry shell-style quoting; strip one matching pair.
function unquoteDotEnvValue(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function readFactoryDotEnvKey(): string | null {
  if (!existsSync(FACTORY_ENV_FILE)) {
    return null
  }
  try {
    const content = readFileSync(FACTORY_ENV_FILE, 'utf8')
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) {
        continue
      }
      const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
      const separator = withoutExport.indexOf('=')
      if (separator <= 0) {
        continue
      }
      const key = withoutExport.slice(0, separator).trim()
      if (key !== 'FACTORY_API_KEY') {
        continue
      }
      const value = unquoteDotEnvValue(withoutExport.slice(separator + 1)).trim()
      if (value.length > 0) {
        return value
      }
    }
  } catch {
    return null
  }
  return null
}

function readFactoryEnvKey(): string | null {
  const raw = process.env.FACTORY_API_KEY
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function resolveFactoryApiKey(): FactoryApiKeyReadResult {
  try {
    const stored = readFactoryApiKey()
    if (stored !== null && stored.trim().length > 0) {
      return { status: 'ok', apiKey: stored.trim(), source: 'orca' }
    }
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Factory API key could not be decrypted'
    }
  }
  const fromEnv = readFactoryEnvKey()
  if (fromEnv !== null) {
    return { status: 'ok', apiKey: fromEnv, source: 'env' }
  }
  const fromDotEnv = readFactoryDotEnvKey()
  if (fromDotEnv !== null) {
    return { status: 'ok', apiKey: fromDotEnv, source: 'dotenv' }
  }
  return { status: 'missing' }
}
