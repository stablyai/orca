import { readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { sanitizeCrashReportString } from '../../shared/crash-reporting'
import {
  loadWindowsSecurity,
  WINDOWS_FILE_READ_EXECUTE,
  type WindowsSecurity
} from '../../shared/windows-security-addon'

/** ALL RESTRICTED APPLICATION PACKAGES: the grant that cleared electron/electron#51761. */
export const RESTRICTED_APP_PACKAGES_SID = 'S-1-15-2-2'

export type InstallDirPackageGrantOutcome = {
  ok: boolean
  /** Entries whose DACL could not be written (or read, for a directory listing). */
  failedFileCount: number
  reason?: string
}

/** Grant root inheritably for future updates; tree pass reaches shipped entries with protected DACLs that cannot inherit it. */
export type InstallDirPackageGrants = {
  root: (installDir: string) => Promise<InstallDirPackageGrantOutcome>
  tree: (installDir: string) => Promise<InstallDirPackageGrantOutcome>
}

const ADDON_UNAVAILABLE: InstallDirPackageGrantOutcome = {
  ok: false,
  failedFileCount: 0,
  reason: 'addon-unavailable'
}

/** Additive only: preserve SYSTEM/admin/user/orphan ACEs. */
function grantPackageRead(
  security: WindowsSecurity,
  path: string,
  inheritable: boolean
): Promise<void> {
  return security.addon.grantAccessAsync(
    path,
    RESTRICTED_APP_PACKAGES_SID,
    WINDOWS_FILE_READ_EXECUTE,
    {
      inheritable,
      replace: false
    }
  )
}

export async function grantInstallDirPackageRoot(
  installDir: string
): Promise<InstallDirPackageGrantOutcome> {
  const security = loadWindowsSecurity()
  if ('error' in security) {
    return ADDON_UNAVAILABLE
  }
  try {
    await grantPackageRead(security, installDir, true)
    return { ok: true, failedFileCount: 0 }
  } catch (error) {
    return { ok: false, failedFileCount: 1, reason: sanitizeCrashReportString(String(error), 200) }
  }
}

/** Continue past failures. Files need flagless grants; only protected directories need inheritable grants. Re-granting others needlessly repropagates subtrees (3.2s/1093 dirs measured). */
export async function grantInstallDirPackageTree(
  installDir: string
): Promise<InstallDirPackageGrantOutcome> {
  const security = loadWindowsSecurity()
  if ('error' in security) {
    return ADDON_UNAVAILABLE
  }
  let failedFileCount = 0
  let firstFailure: string | undefined
  const attempt = async (step: () => Promise<void> | void): Promise<void> => {
    try {
      await step()
    } catch (error) {
      failedFileCount += 1
      firstFailure ??= sanitizeCrashReportString(String(error), 200)
    }
  }
  const pending = [installDir]
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    const current = directory
    let entries: Dirent[] = []
    await attempt(() => {
      entries = readdirSync(current, { withFileTypes: true })
    })
    for (const entry of entries) {
      const path = join(current, entry.name)
      // Do not follow junctions outside this install tree.
      if (entry.isSymbolicLink()) {
        continue
      }
      if (!entry.isDirectory()) {
        await attempt(() => grantPackageRead(security, path, false))
        continue
      }
      pending.push(path)
      await attempt(async () => {
        if (security.addon.getDaclAces(path)?.protected) {
          await grantPackageRead(security, path, true)
        }
      })
    }
  }
  return failedFileCount === 0
    ? { ok: true, failedFileCount: 0 }
    : { ok: false, failedFileCount, reason: `failed-files: ${firstFailure}` }
}

export const installDirPackageGrants: InstallDirPackageGrants = {
  root: grantInstallDirPackageRoot,
  tree: grantInstallDirPackageTree
}
