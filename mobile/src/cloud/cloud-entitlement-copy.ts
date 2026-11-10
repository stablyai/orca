import type { Translate } from '../i18n/mobile-i18n'
import { readCloudRole, type CloudRole } from './cloud-control-plane-client'
import { CloudRequestError, type CloudControlPlane } from './cloud-control-plane-request'

// What the phone says when the plan says no (glossary "Out of hours", "Payment problem"): what
// happened, whether anything was lost or charged, and one next step chosen by role. Owners and
// admins fix billing in Orca on their computer; members are sent to them.

type Denial = 'hours' | 'cap' | 'payment' | 'plan' | 'teamLimit' | 'memberLimit' | 'other'

function denialOf(reason: string | undefined): Denial {
  switch (reason) {
    case 'included_hours_exhausted':
      return 'hours'
    case 'overage_cap_reached':
      return 'cap'
    case 'payment_past_due':
    case 'payment_grace_expired':
      return 'payment'
    case 'no_subscription':
    case 'subscription_inactive':
      return 'plan'
    case 'concurrency_limit':
      return 'teamLimit'
    case 'member_concurrency_limit':
      return 'memberLimit'
    default:
      return 'other'
  }
}

export function isEntitlementDenied(error: unknown): error is CloudRequestError {
  return error instanceof CloudRequestError && error.code === 'entitlement_denied'
}

/** The role only matters for a plan denial, so it is read only then; unknown falls back to member copy. */
export async function roleForCloudError(
  error: unknown,
  plane: CloudControlPlane | null,
  signal?: AbortSignal
): Promise<CloudRole | null> {
  if (!plane || !isEntitlementDenied(error)) {
    return null
  }
  return readCloudRole(plane, signal).catch(() => null)
}

function problem(denial: Denial, when: 'create' | 'existing', t: Translate): string {
  switch (denial) {
    case 'hours':
      return t('cloud.denied.hours', 'Out of sandbox hours.')
    case 'cap':
      return t('cloud.denied.cap', 'Spend cap reached.')
    case 'payment':
      return t('cloud.denied.payment', 'Payment failed, so new sandboxes can’t start.')
    case 'plan':
      return t('cloud.denied.plan', 'Orca Cloud needs a Team plan.')
    case 'teamLimit':
      return t(
        'cloud.denied.teamLimit',
        'Your team is at its limit of running sandboxes (3 per seat).'
      )
    case 'memberLimit':
      // The per-seat cap counts the workspace owner's seat, not the seat of whoever wakes it, and
      // the phone can't always tell whose workspace this is, so an existing one names the owner.
      return when === 'create'
        ? t('cloud.denied.memberLimit', 'You’re at your limit of running sandboxes.')
        : t(
            'cloud.denied.ownerSeatLimit',
            'The workspace owner is at their limit of running sandboxes, and this workspace runs on their seat.'
          )
    case 'other':
      return t('cloud.denied.other', 'Your team’s plan doesn’t allow this right now.')
  }
}

function nextStep(
  denial: Denial,
  manager: boolean,
  when: 'create' | 'existing',
  t: Translate
): string {
  switch (denial) {
    case 'memberLimit':
      if (when === 'existing') {
        return t(
          'cloud.denied.next.ownerSeatLimit',
          'Ask them to put one to sleep (or put one to sleep yourself if it’s your workspace), then try again.'
        )
      }
      return t('cloud.denied.next.limit', 'Put one to sleep or delete it, then try again.')
    case 'teamLimit':
      return t('cloud.denied.next.limit', 'Put one to sleep or delete it, then try again.')
    case 'hours':
      return manager
        ? t(
            'cloud.denied.next.hoursAdmin',
            'Turn on overage in Orca on your computer, then try again.'
          )
        : t('cloud.denied.next.hoursMember', 'Ask an owner or admin to add hours.')
    case 'cap':
      return manager
        ? t(
            'cloud.denied.next.capAdmin',
            'Raise the spend cap in Orca on your computer, then try again.'
          )
        : t('cloud.denied.next.capMember', 'Ask an owner or admin to raise the spend cap.')
    case 'payment':
      return manager
        ? t('cloud.denied.next.paymentAdmin', 'Update the payment method in Orca on your computer.')
        : t(
            'cloud.denied.next.paymentMember',
            'Ask an owner or admin to update the payment method.'
          )
    case 'plan':
      return manager
        ? t('cloud.denied.next.planAdmin', 'Choose a plan in Orca on your computer.')
        : t('cloud.denied.next.planMember', 'Ask an owner or admin to choose a plan.')
    case 'other':
      return manager
        ? t('cloud.denied.next.otherAdmin', 'Check billing in Orca on your computer.')
        : t('cloud.denied.next.otherMember', 'Ask an owner or admin to check billing.')
  }
}

/** `create`: nothing exists yet; `existing`: the workspace (and its files) already does. */
export function entitlementDeniedMessage(
  error: CloudRequestError,
  role: CloudRole | null,
  when: 'create' | 'existing',
  t: Translate
): string {
  const denial = denialOf(error.reason)
  const manager = role === 'owner' || role === 'admin'
  return t('cloud.denied.message', '{{problem}} {{safety}} {{next}}', {
    problem: problem(denial, when, t),
    safety:
      when === 'create'
        ? t('cloud.denied.safety.create', 'Nothing was created, and you weren’t charged.')
        : t('cloud.denied.safety.existing', 'Your files are safe.'),
    next: nextStep(denial, manager, when, t)
  })
}
