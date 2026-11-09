import { ipcMain } from 'electron'
import { z } from 'zod'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingOpenResult,
  OrcaBillingStatusResult
} from '../../../shared/orca-billing'
import { isOrcaBillingPlanId } from '../../../shared/orca-billing'
import {
  getOrcaBillingStatus,
  openOrcaBillingCheckout,
  openOrcaBillingPortal
} from '../../billing/billing-service'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'

const MAX_TEAM_SEATS = 500

const CheckoutArgs = z.object({
  plan: z.unknown(),
  seats: z.unknown().optional()
})

export function billingCheckoutArgsFromUnknown(args: unknown): OrcaBillingCheckoutArgs {
  const record = CheckoutArgs.safeParse(args).data
  const plan = record?.plan
  if (!isOrcaBillingPlanId(plan)) {
    throw new Error('invalid_orca_billing_plan')
  }
  const seats = record?.seats
  if (seats === undefined || plan !== 'team') {
    return { plan }
  }
  if (
    typeof seats !== 'number' ||
    !Number.isInteger(seats) ||
    seats < 1 ||
    seats > MAX_TEAM_SEATS
  ) {
    throw new Error('invalid_orca_billing_seats')
  }
  return { plan, seats }
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
  ipcMain.handle('orcaProfiles:billingOpenPortal', async (): Promise<OrcaBillingOpenResult> =>
    openOrcaBillingPortal(getProfileUserDataPath())
  )
}
