import { existsSync } from 'node:fs'
import {
  getForkedChildEntryPath,
  resolveForkedChildEntryPath,
  resolveForkedChildEntryPathWithoutApp
} from '../forked-child-entry-path'

// orcad resolves this literal beside orcad.js; build-orcad.mjs emits it from ORCAD_CHILD_ENTRY_POINTS.
export const AI_VAULT_SERVICE_ENTRY_FILENAME = 'session-scanner-service-entry.js'

export function resolveAiVaultServiceEntryPath(
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  return resolveForkedChildEntryPath(
    AI_VAULT_SERVICE_ENTRY_FILENAME,
    appPath,
    isPackaged,
    pathExists
  )
}

export function resolveAiVaultServiceEntryPathWithoutApp(
  cwd: string,
  resourcesPath: string | undefined,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  return resolveForkedChildEntryPathWithoutApp(
    AI_VAULT_SERVICE_ENTRY_FILENAME,
    cwd,
    resourcesPath,
    pathExists
  )
}

export function getAiVaultServiceEntryPath(): string {
  return getForkedChildEntryPath(AI_VAULT_SERVICE_ENTRY_FILENAME)
}
