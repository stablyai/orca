import { hostname } from 'node:os'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { getVersionChannel } from '../../../shared/updater/release-channel'
import type { UpdateStatus } from '../../../shared/updater/update-status-types'
import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import {
  getGoverningTeamCapabilities,
  ORCA_CLOUD_DESKTOP_REPORTING
} from '../../../shared/orca-profiles/orca-cloud-team-policy'
import type { OrcaCloudSessionIdentity } from '../cloud-session/profile-cloud-session-store'
import { getRequiredPluginFailureHeader } from '../../plugins/catalog/required-plugin-failures'

let readUpdateStatus: (() => UpdateStatus) | undefined

export function setDesktopReportUpdateStatus(read: () => UpdateStatus): void {
  readUpdateStatus = read
}

function updateReportFields(status: UpdateStatus | undefined): string[] {
  if (status?.state === 'downloading') {
    return ['upd=downloading']
  }
  if (status?.state === 'downloaded') {
    if (
      status.teamRestart?.phase === 'manual' ||
      status.teamRestart?.phase === 'retry-next-launch'
    ) {
      return ['upd=failed-install', 'err=required_restart_failed']
    }
    return ['upd=ready']
  }
  if (
    (status?.state === 'available' && status.externallyManaged) ||
    (status?.state === 'error' &&
      (status.recovery?.reason === 'manual-install-required' ||
        status.messageCode === 'linuxPackageExternallyManaged'))
  ) {
    return ['upd=manual']
  }
  if (status?.state === 'error') {
    if (status.failurePhase === 'install') {
      const code = status.recovery?.reason ?? status.messageCode
      return ['upd=failed-install', `err=${code ?? 'update_install_failed'}`]
    }
    if (status.failurePhase === 'download') {
      return ['upd=failed-download']
    }
  }
  return ['upd=idle']
}

export function collectAuthorizedDesktopReport(
  capabilities: OrcaCloudCapabilities,
  identity: OrcaCloudSessionIdentity | undefined
): Record<string, string> | undefined {
  const policy = getGoverningTeamCapabilities(capabilities)?.teamPolicy
  if (
    capabilities.flags[ORCA_CLOUD_DESKTOP_REPORTING] !== true ||
    !policy?.reportingOrgIds?.some((id) => policy.orgIds.includes(id)) ||
    !hasAppEnvironment()
  ) {
    return undefined
  }
  const version = getAppEnvironment().getVersion()
  const channel = getVersionChannel(version)
  const fields = [`v=${version}`, `os=${process.platform}-${process.arch}`]
  if (channel) {
    fields.push(`ch=${channel}`)
  }
  fields.push(...updateReportFields(readUpdateStatus?.()))
  const label = hostname().slice(0, 256).toWellFormed()
  if (label) {
    fields.push(`label=${encodeURIComponent(label)}`)
  }
  const failures = getRequiredPluginFailureHeader(identity)
  return {
    'x-orca-client': fields.join('; '),
    'x-orca-app-version': version,
    ...(failures !== undefined ? { 'x-orca-required-plugin-failures': failures } : {})
  }
}
