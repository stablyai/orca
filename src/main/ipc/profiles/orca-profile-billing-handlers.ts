import { ipcMain } from 'electron'
import { z } from 'zod'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingOpenResult,
  OrcaBillingOverageArgs,
  OrcaBillingOverageResult,
  OrcaBillingStatusResult
} from '../../../shared/orca-billing'
import {
  ORCA_BILLING_INTERVALS,
  ORCA_BILLING_MAX_SEATS,
  ORCA_BILLING_PLAN_IDS
} from '../../../shared/orca-billing'
import {
  getOrcaBillingStatus,
  openOrcaBillingCheckout,
  openOrcaBillingPortal,
  setOrcaBillingOverage
} from '../../billing/billing-service'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'

const CheckoutArgs = z
  .object({
    plan: z.enum(ORCA_BILLING_PLAN_IDS),
    interval: z.enum(ORCA_BILLING_INTERVALS),
    seats: z.number().int().min(1).max(ORCA_BILLING_MAX_SEATS)
  })
  .strict()

// Cents; the billing service enforces the plan's maximum.
const OverageArgs = z
  .object({
    enabled: z.boolean(),
    spendCapCents: z.number().int().min(0).max(100_000_000).optional()
  })
  .strict()

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

export function registerOrcaProfileBillingHandlers(): void {
  ipcMain.handle('orcaProfiles:billingStatus', async (): Promise<OrcaBillingStatusResult> =>
    getOrcaBillingStatus(getProfileUserDataPath())
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
  ipcMain.handle('orcaProfiles:billingOpenPortal', async (): Promise<OrcaBillingOpenResult> =>
    openOrcaBillingPortal(getProfileUserDataPath())
  )
}
