// What a failed Checkout/Portal open means, as a typed result the plans dialog can act on.
import type { OrcaBillingOpenRefusal } from '../../shared/orca-billing'
import { BillingServiceError } from './billing-client'

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function openResultForError(error: unknown): OrcaBillingOpenRefusal {
  if (error instanceof BillingServiceError) {
    if (error.statusCode === 403) {
      return { status: 'forbidden' }
    }
    if (error.errorCode === 'already_subscribed') {
      return { status: 'already-subscribed' }
    }
    if (error.errorCode === 'no_billing_account') {
      return { status: 'no-billing-account' }
    }
    if (error.errorCode === 'team_required') {
      return { status: 'team-required' }
    }
    if (error.errorCode === 'plan_unavailable') {
      return { status: 'plan-unavailable' }
    }
  }
  return { status: 'failed', error: message(error) }
}
