// "Manage in browser": opens a web console page for the active profile's account.
import { ipcMain } from 'electron'
import {
  isOrcaCloudConsoleSection,
  parseOrcaCloudConsoleBillingHint,
  type OrcaCloudConsoleOpenResult
} from '../../../shared/orca-cloud-console'
import { openOrcaCloudConsole } from '../../orca-profiles/cloud-console/cloud-console-link'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'

export function registerOrcaCloudConsoleHandlers(): void {
  ipcMain.handle(
    'orcaProfiles:openCloudConsole',
    async (_event, rawArgs: unknown): Promise<OrcaCloudConsoleOpenResult> => {
      const section =
        typeof rawArgs === 'object' && rawArgs !== null && 'section' in rawArgs
          ? rawArgs.section
          : undefined
      if (!isOrcaCloudConsoleSection(section)) {
        return { status: 'failed', error: 'invalid_orca_cloud_console_section' }
      }
      const billingHint =
        section === 'billing' &&
        typeof rawArgs === 'object' &&
        rawArgs !== null &&
        'billingHint' in rawArgs
          ? parseOrcaCloudConsoleBillingHint(rawArgs.billingHint)
          : null
      return openOrcaCloudConsole(getProfileUserDataPath(), section, { billingHint })
    }
  )
}
