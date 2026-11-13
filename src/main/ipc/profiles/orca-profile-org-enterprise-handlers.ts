// IPC for Settings › Enterprise (single sign-on and directory sync) on the active profile's team.
import { ipcMain } from 'electron'
import {
  ORCA_ORG_SSO_DOMAIN_MAX_LENGTH,
  type OrcaProfileOrgEnterpriseResult,
  type OrcaProfileOrgSsoDomainResult,
  type OrcaProfileOrgSsoSetupLinkResult
} from '../../../shared/orca-org-enterprise'
import {
  changeOrcaProfileOrgSsoDomain,
  createOrcaProfileOrgSsoSetupLink,
  getOrcaProfileOrgEnterprise
} from '../../orca-profiles/cloud-org/profile-cloud-org-enterprise-service'
import type { OrgSsoDomainAction } from '../../orca-profiles/cloud-org/profile-cloud-org-enterprise-client'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'

function orgIdFromUnknown(args: unknown): { orgId: string; record: Record<string, unknown> } {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_orca_profile_org_selection')
  }
  const record = args as Record<string, unknown>
  const orgId = typeof record.orgId === 'string' ? record.orgId.trim() : ''
  if (!orgId) {
    throw new Error('invalid_orca_profile_org_selection')
  }
  return { orgId, record }
}

function domainFromUnknown(value: unknown): string {
  const domain = typeof value === 'string' ? value.trim() : ''
  if (!domain || domain.length > ORCA_ORG_SSO_DOMAIN_MAX_LENGTH) {
    throw new Error('invalid_orca_org_sso_domain')
  }
  return domain
}

export function registerOrcaProfileOrgEnterpriseHandlers(): void {
  ipcMain.handle(
    'orcaProfiles:orgEnterprise',
    async (_event, rawArgs: unknown): Promise<OrcaProfileOrgEnterpriseResult> =>
      getOrcaProfileOrgEnterprise(getProfileUserDataPath(), orgIdFromUnknown(rawArgs).orgId)
  )

  ipcMain.handle(
    'orcaProfiles:orgSsoSetupLink',
    async (_event, rawArgs: unknown): Promise<OrcaProfileOrgSsoSetupLinkResult> =>
      createOrcaProfileOrgSsoSetupLink(getProfileUserDataPath(), orgIdFromUnknown(rawArgs).orgId)
  )

  const domainHandler =
    (action: OrgSsoDomainAction) =>
    async (_event: unknown, rawArgs: unknown): Promise<OrcaProfileOrgSsoDomainResult> => {
      const { orgId, record } = orgIdFromUnknown(rawArgs)
      return changeOrcaProfileOrgSsoDomain(getProfileUserDataPath(), {
        orgId,
        domain: domainFromUnknown(record.domain),
        action
      })
    }
  ipcMain.handle('orcaProfiles:orgSsoDomainAdd', domainHandler('add'))
  ipcMain.handle('orcaProfiles:orgSsoDomainVerify', domainHandler('verify'))
  ipcMain.handle('orcaProfiles:orgSsoDomainRemove', domainHandler('remove'))
}
