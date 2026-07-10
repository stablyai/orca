import { ONBOARDING_FINAL_STEP, ONBOARDING_FLOW_VERSION } from '../../shared/constants'
import { CONTEXTUAL_TOUR_IDS } from '../../shared/contextual-tours'
import {
  FEATURE_INTERACTION_IDS,
  type FeatureInteractionState
} from '../../shared/feature-interactions'
import { FEATURE_TIP_IDS } from '../../shared/feature-tips'
import type { PersistedUIState } from '../../shared/types'
import type { Store } from '../persistence'

export const DEV_SHOW_FIRST_RUN_EDUCATION_ENV = 'ORCA_DEV_SHOW_FIRST_RUN_EDUCATION'

type DevEducationStore = Pick<Store, 'getOnboarding' | 'updateOnboarding' | 'getUI' | 'updateUI'>

export function shouldSuppressDevEducation(args: {
  isDev: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  const env = args.env ?? process.env
  return (
    args.isDev &&
    env.ORCA_E2E_USER_DATA_DIR === undefined &&
    env[DEV_SHOW_FIRST_RUN_EDUCATION_ENV] !== '1'
  )
}

export function suppressDevEducationForStore(store: DevEducationStore, now = Date.now()): void {
  const onboarding = store.getOnboarding()
  if (onboarding.closedAt === null) {
    // Why: default dev launches should behave like an already-productive
    // profile, while the env escape hatch keeps first-run surfaces testable.
    store.updateOnboarding({
      flowVersion: ONBOARDING_FLOW_VERSION,
      closedAt: now,
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    })
  }

  const ui = store.getUI()
  const nextFeatureTipsSeenIds = mergeUnique(ui.featureTipsSeenIds, FEATURE_TIP_IDS)
  const nextContextualToursSeenIds = mergeUnique(ui.contextualToursSeenIds, CONTEXTUAL_TOUR_IDS)
  const nextFeatureInteractions = fillFeatureInteractions(ui.featureInteractions, now)

  const updates: Partial<PersistedUIState> = {}
  if (!sameArray(ui.featureTipsSeenIds, nextFeatureTipsSeenIds)) {
    updates.featureTipsSeenIds = nextFeatureTipsSeenIds
  }
  if (!sameArray(ui.contextualToursSeenIds, nextContextualToursSeenIds)) {
    updates.contextualToursSeenIds = nextContextualToursSeenIds
  }
  if (ui.contextualToursAutoEligible !== false) {
    updates.contextualToursAutoEligible = false
  }
  if (
    Object.keys(nextFeatureInteractions).length !== Object.keys(ui.featureInteractions ?? {}).length
  ) {
    updates.featureInteractions = nextFeatureInteractions
  }

  if (Object.keys(updates).length > 0) {
    store.updateUI(updates)
  }
}

function mergeUnique<const T extends string>(
  current: readonly T[] | undefined,
  additions: readonly T[]
): T[] {
  return [...new Set([...(current ?? []), ...additions])]
}

function fillFeatureInteractions(
  current: FeatureInteractionState | undefined,
  now: number
): FeatureInteractionState {
  const next: FeatureInteractionState = { ...current }
  for (const id of FEATURE_INTERACTION_IDS) {
    next[id] ??= {
      firstInteractedAt: now,
      interactionCount: 1
    }
  }
  return next
}

function sameArray<T>(a: readonly T[] | undefined, b: readonly T[]): boolean {
  return (a ?? []).length === b.length && (a ?? []).every((value, index) => value === b[index])
}
