import { ipcMain } from 'electron'
import { z } from 'zod'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingOpenResult,
  OrcaBillingOverageArgs,
  OrcaBillingOverageResult,
  OrcaBillingStatusResult,
  OrcaBillingTeamPlansResult,
  OrcaBillingTrialClaimResult,
  OrcaBillingUsageHistoryResult
} from '../../../shared/orca-billing'
import type { OrcaPlanCatalogResult } from '../../../shared/orca-billing-plans'
import {
  ORCA_BILLING_INTERVALS,
  ORCA_BILLING_MAX_SEATS,
  ORCA_BILLING_TEAM_PLANS_MAX_ORGS
} from '../../../shared/orca-billing'
import {
  claimOrcaBillingTrial,
  getOrcaBillingStatus,
  getOrcaBillingTeamPlans,
  getOrcaBillingUsageHistory,
  getOrcaPlanCatalog,
  openOrcaBillingCheckout,
  openOrcaBillingPortal,
  setOrcaBillingOverage
} from '../../billing/billing-service'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { ensureActiveOrcaProfile } from '../../orca-profiles/profile-index-store'
import { notifyUsageAlertIfDue } from '../../billing/usage-alert-notifier'
import { showUsageAlertNotification, usageAlertBody } from '../../billing/usage-alert-desktop'
import type { Store } from '../../persistence/loading-store/store'
import {
  CLOUD_SETUP_NEEDS,
  CLOUD_SETUP_SESSION_ID,
  type CloudSetupGetResult,
  type CloudSetupLinkResult,
  type CloudSetupStartArgs,
  type CloudSetupStartResult
} from '../../../shared/orca-cloud-setup'
import {
  getCloudSetupLink,
  getCloudSetupSession,
  startCloudSetup
} from '../../billing/cloud-setup-service'

const CheckoutArgs = z
  .object({
    // A plan id from billing's catalog (GET /v1/plans); billing decides what it sells.
    plan: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    interval: z.enum(ORCA_BILLING_INTERVALS),
    seats: z.number().int().min(1).max(ORCA_BILLING_MAX_SEATS),
    setupSessionId: z.string().regex(CLOUD_SETUP_SESSION_ID).optional()
  })
  .strict()

// Cents; the billing service enforces the plan's maximum.
const OverageArgs = z
  .object({
    enabled: z.boolean(),
    spendCapCents: z.number().int().min(0).max(100_000_000).optional()
  })
  .strict()

// Minutes east of UTC (the renderer's -getTimezoneOffset()), so chart days are local days.
const UsageHistoryArgs = z
  .object({ utcOffsetMinutes: z.number().int().min(-840).max(840) })
  .strict()

export function billingUsageHistoryArgsFromUnknown(args: unknown): {
  utcOffsetMinutes: number
} {
  const parsed = UsageHistoryArgs.safeParse(args)
  if (!parsed.success) {
    throw new Error('invalid_orca_billing_usage_history')
  }
  return parsed.data
}

const TeamPlansArgs = z
  .object({
    orgIds: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_.:-]+$/)
      )
      .max(ORCA_BILLING_TEAM_PLANS_MAX_ORGS)
  })
  .strict()

export function billingTeamPlansArgsFromUnknown(args: unknown): {
  orgIds: string[]
} {
  const parsed = TeamPlansArgs.safeParse(args)
  if (!parsed.success) {
    throw new Error('invalid_orca_billing_team_plans')
  }
  return { orgIds: [...new Set(parsed.data.orgIds)] }
}

const CloudSetupStart = z
  .object({
    repo: z.string().url().startsWith('https://github.com/').max(300).optional(),
    needs: z.array(z.enum(CLOUD_SETUP_NEEDS)).max(3),
    chooseTeam: z.boolean().optional()
  })
  .strict()

const CloudSetupGet = z.object({ sessionId: z.string().regex(CLOUD_SETUP_SESSION_ID) }).strict()

export function cloudSetupStartArgsFromUnknown(args: unknown): CloudSetupStartArgs {
  const parsed = CloudSetupStart.safeParse(args)
  if (!parsed.success) {
    throw new Error('invalid_cloud_setup_start')
  }
  return parsed.data
}

export function billingCheckoutArgsFromUnknown(args: unknown): OrcaBillingCheckoutArgs {
  const parsed = CheckoutArgs.safeParse(args)
  if (!parsed.success) {
    throw new Error('invalid_orca_billing_checkout')
  }
  return parsed.data
}

export function billingOverageArgsFromUnknown(args: unknown): OrcaBillingOverageArgs {
  const parsed = OverageArgs.safeParse(args)
  if (!parsed.success) {
    throw new Error('invalid_orca_billing_overage')
  }
  return parsed.data
}

/** `${userId}:${activeOrgId}` for the active profile's account (as the renderer keys it), or null. */
function billingAccountKey(userDataPath: string): string | null {
  const cloud = ensureActiveOrcaProfile(userDataPath).profile.cloud
  return cloud ? `${cloud.userId}:${cloud.activeOrgId ?? ''}` : null
}

export function registerOrcaProfileBillingHandlers(store: Store): void {
  ipcMain.handle('orcaProfiles:billingStatus', async (): Promise<OrcaBillingStatusResult> => {
    const userDataPath = getProfileUserDataPath()
    const account = billingAccountKey(userDataPath)
    const result = await getOrcaBillingStatus(userDataPath)
    // An account or team switch mid-read means this answer isn't for the account now active.
    if (result.status === 'ok' && account && account === billingAccountKey(userDataPath)) {
      // Fire and forget: an alert must never delay or fail the billing read.
      void notifyUsageAlertIfDue(account, result.entitlement, {
        userDataPath,
        notificationsEnabled: () => store.getSettings().notifications?.enabled !== false,
        body: usageAlertBody,
        show: showUsageAlertNotification
      }).catch(() => {})
    }
    return result
  })
  ipcMain.handle('orcaProfiles:billingPlans', async (): Promise<OrcaPlanCatalogResult> =>
    getOrcaPlanCatalog(getProfileUserDataPath())
  )
  ipcMain.handle(
    'orcaProfiles:billingOpenCheckout',
    async (_event, rawArgs: unknown): Promise<OrcaBillingOpenResult> =>
      openOrcaBillingCheckout(getProfileUserDataPath(), billingCheckoutArgsFromUnknown(rawArgs))
  )
  ipcMain.handle(
    'orcaProfiles:billingSetOverage',
    async (_event, rawArgs: unknown): Promise<OrcaBillingOverageResult> =>
      setOrcaBillingOverage(getProfileUserDataPath(), billingOverageArgsFromUnknown(rawArgs))
  )
  ipcMain.handle(
    'orcaProfiles:billingUsageHistory',
    async (_event, rawArgs: unknown): Promise<OrcaBillingUsageHistoryResult> =>
      getOrcaBillingUsageHistory(
        getProfileUserDataPath(),
        billingUsageHistoryArgsFromUnknown(rawArgs).utcOffsetMinutes
      )
  )
  ipcMain.handle(
    'orcaProfiles:billingTeamPlans',
    async (_event, rawArgs: unknown): Promise<OrcaBillingTeamPlansResult> =>
      getOrcaBillingTeamPlans(
        getProfileUserDataPath(),
        billingTeamPlansArgsFromUnknown(rawArgs).orgIds
      )
  )
  ipcMain.handle(
    'orcaProfiles:cloudSetupStart',
    async (_event, rawArgs: unknown): Promise<CloudSetupStartResult> =>
      startCloudSetup(getProfileUserDataPath(), cloudSetupStartArgsFromUnknown(rawArgs))
  )
  ipcMain.handle(
    'orcaProfiles:cloudSetupGet',
    async (_event, rawArgs: unknown): Promise<CloudSetupGetResult> => {
      const parsed = CloudSetupGet.safeParse(rawArgs)
      return parsed.success
        ? getCloudSetupSession(getProfileUserDataPath(), parsed.data.sessionId)
        : { status: 'not-found' }
    }
  )
  ipcMain.handle(
    'orcaProfiles:cloudSetupLink',
    async (_event, rawArgs: unknown): Promise<CloudSetupLinkResult> => {
      const parsed = CloudSetupGet.safeParse(rawArgs)
      return parsed.success
        ? getCloudSetupLink(getProfileUserDataPath(), parsed.data.sessionId)
        : { status: 'not-found' }
    }
  )
  ipcMain.handle('orcaProfiles:billingClaimTrial', async (): Promise<OrcaBillingTrialClaimResult> =>
    claimOrcaBillingTrial(getProfileUserDataPath())
  )
  ipcMain.handle('orcaProfiles:billingOpenPortal', async (): Promise<OrcaBillingOpenResult> =>
    openOrcaBillingPortal(getProfileUserDataPath())
  )
}
