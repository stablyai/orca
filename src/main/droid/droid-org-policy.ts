import { join } from 'node:path'
import { readHooksJson } from '../agent-hooks/installation/configuration/hooks-json-read'
import type { SFTPWrapper } from 'ssh2'
import { readHooksJsonRemote } from '../agent-hooks/installation/configuration/hooks-json-remote'
import {
  DROID_MACOS_ORG_SETTINGS_PATH,
  DROID_POSIX_ORG_SETTINGS_PATH
} from '../../shared/droid/droid-org-settings-path'

/** Where Factory documents the organization-managed settings file for each OS. */
export function getDroidOrgSettingsPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') {
    return DROID_MACOS_ORG_SETTINGS_PATH
  }
  if (platform === 'win32') {
    return join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Factory', 'settings.json')
  }
  return DROID_POSIX_ORG_SETTINGS_PATH
}

/**
 * True only when the org file says user and project hooks are ignored. A missing or unreadable file
 * is an empty policy, which is what Factory documents for an invalid one.
 */
export function orgAllowsManagedHooksOnly(orgSettingsPath: string): boolean {
  return readHooksJson(orgSettingsPath)?.allowManagedHooksOnly === true
}

export async function orgAllowsManagedHooksOnlyRemote(
  sftp: SFTPWrapper,
  platform: 'linux' | 'darwin'
): Promise<boolean> {
  try {
    const settings = await readHooksJsonRemote(sftp, getDroidOrgSettingsPath(platform))
    return settings?.allowManagedHooksOnly === true
  } catch {
    // Factory treats an unreadable organization file as empty policy.
    return false
  }
}
