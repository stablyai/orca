import {
  classifyEntitlementDenial,
  type OrcaEntitlementDenialKind
} from '../../../src/shared/orca-billing'
import type { Translate } from '../i18n/mobile-i18n'
import {
  readCloudRole,
  readCloudWorkspaceOwner,
  type CloudRole,
  type CloudSeatOwner
} from './cloud-control-plane-client'
import { CloudRequestError, type CloudControlPlane } from './cloud-control-plane-request'

// What the phone says when the plan says no (glossary "Out of hours", "Payment problem"): what
// happened, whether anything was lost or charged, and one next step chosen by role. Owners and
// admins fix billing in Orca on their computer; members are sent to them.

type Denial =
  | 'hours'
  | 'cap'
  | 'payment'
  | 'plan'
  | 'trialUsedUp'
  | 'trialUnavailable'
  | 'teamLimit'
  | 'memberLimit'
  | 'other'

// The shared classifier names the category; the phone keeps its own wording per category.
const DENIALS: Record<OrcaEntitlementDenialKind, Denial> = {
  plan: 'plan',
  hours: 'hours',
  spendCap: 'cap',
  payment: 'payment',
  teamLimit: 'teamLimit',
  memberLimit: 'memberLimit',
  machineSize: 'other',
  other: 'other'
}

function denialOf(reason: string | undefined): Denial {
  // Both trial reasons classify as 'plan' (a plan fixes them) but say what happened to the trial.
  if (reason === 'trial_used_up') {
    return 'trialUsedUp'
  }
  if (reason === 'trial_unavailable') {
    return 'trialUnavailable'
  }
  return DENIALS[classifyEntitlementDenial(reason)]
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

/** Only a per-seat limit on an existing workspace needs its owner; anything else reads nothing. */
export async function ownerForCloudError(
  error: unknown,
  plane: CloudControlPlane | null,
  sandboxId: string,
  signal?: AbortSignal
): Promise<CloudSeatOwner | null> {
  if (!plane || !isEntitlementDenied(error) || error.reason !== 'member_concurrency_limit') {
    return null
  }
  return readCloudWorkspaceOwner(plane, sandboxId, signal).catch(() => null)
}

function problem(
  denial: Denial,
  when: 'create' | 'existing',
  owner: CloudSeatOwner | null,
  t: Translate
): string {
  switch (denial) {
    case 'hours':
      return t(
        'cloud.denied.hours2',
        'Out of sandbox hours. Running sandboxes go to sleep and new ones can’t start.'
      )
    case 'cap':
      return t(
        'cloud.denied.cap2',
        'Spend cap reached. Running sandboxes go to sleep and new ones can’t start.'
      )
    case 'payment':
      return t('cloud.denied.payment', 'Payment failed, so new sandboxes can’t start.')
    case 'plan':
      return t('cloud.denied.plan', 'Orca Cloud needs a Team plan.')
    case 'trialUsedUp':
      return t(
        'cloud.denied.trialUsedUp',
        'Your trial is used up. Running sandboxes go to sleep and new ones can’t start.'
      )
    case 'trialUnavailable':
      return t('cloud.denied.trialUnavailable', 'This account or team already used its trial.')
    case 'teamLimit':
      // The phone has no plan numbers (and a trial has no seats): no count here.
      return t('cloud.denied.teamLimit2', 'Your team is at its limit of running sandboxes.')
    case 'memberLimit':
      // The per-seat cap counts the workspace owner's seat, not the seat of whoever wakes it, and
      // the phone can't always tell whose workspace this is, so an existing one names the owner.
      if (when === 'create' || owner?.self) {
        return t('cloud.denied.memberLimit', 'You’re at your limit of running sandboxes.')
      }
      if (owner) {
        return t(
          'cloud.denied.teammateSeatLimit',
          '{{name}} is at their limit of running sandboxes, and this workspace runs on their seat.',
          {
            name: owner.name ?? t('cloud.denied.seatOwnerFallback', 'The workspace owner')
          }
        )
      }
      return t(
        'cloud.denied.ownerSeatLimit2',
        'This workspace’s owner is at their limit of running sandboxes.'
      )
    case 'other':
      return t('cloud.denied.other', 'Your team’s plan doesn’t allow this right now.')
  }
}

function nextStep(
  denial: Denial,
  manager: boolean,
  when: 'create' | 'existing',
  owner: CloudSeatOwner | null,
  t: Translate
): string {
  switch (denial) {
    case 'memberLimit':
      if (when === 'existing' && owner && !owner.self) {
        return t(
          'cloud.denied.next.teammateSeatLimit',
          'Ask them to put one to sleep, then try again.'
        )
      }
      if (when === 'existing' && !owner) {
        return t(
          'cloud.denied.next.ownerSeatLimit2',
          'Ask the owner to put one to sleep, or if it’s your workspace, put one to sleep or delete it, then try again.'
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
    case 'trialUsedUp':
    case 'trialUnavailable':
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
  t: Translate,
  owner: CloudSeatOwner | null = null
): string {
  const denial = denialOf(error.reason)
  const manager = role === 'owner' || role === 'admin'
  return t('cloud.denied.message', '{{problem}} {{safety}} {{next}}', {
    problem: problem(denial, when, owner, t),
    safety:
      // Out of hours or at the cap, running sandboxes go to sleep, so say what that keeps.
      denial === 'hours' || denial === 'cap' || denial === 'trialUsedUp'
        ? t('cloud.denied.safety.asleep', 'Nothing is deleted, and your files are safe.')
        : when === 'create'
          ? t('cloud.denied.safety.create', 'Nothing was created, and you weren’t charged.')
          : t('cloud.denied.safety.existing', 'Your files are safe.'),
    next: nextStep(denial, manager, when, owner, t)
  })
}
