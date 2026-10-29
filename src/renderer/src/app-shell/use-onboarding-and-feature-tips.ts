import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { onOnboardingReopened } from '../components/onboarding/show-onboarding-event'
import { shouldShowOnboarding } from '../components/onboarding/should-show-onboarding'
import {
  getFeatureTipsAppOpenDecision,
  isCliFeatureTipCompleted
} from '../components/feature-tips/feature-tip-startup-gate'
import {
  trackCmdJPaletteFeatureTipShown,
  trackOrcaCliFeatureTipShown
} from '../components/feature-tips/feature-tip-telemetry'
import { useAppStore } from '../store'
import { isWebClientLocation } from '../lib/web-client-location'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import { isInNativeChatUpgradeTipAudience } from '../../../shared/native-chat/native-chat-upgrade-tip-audience'

export type OnboardingGate = ReturnType<typeof useOnboardingAndFeatureTips>

/** Keep feature-tip education suppressed until onboarding state is known. */
export function useOnboardingAndFeatureTips() {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null)
  const [onboardingLoaded, setOnboardingLoaded] = useState(false)
  const [featureTipCliInstalled, setFeatureTipCliInstalled] = useState<boolean | null>(null)
  const promptedThisSessionRef = useRef(false)
  const suppressedByOnboardingThisSessionRef = useRef(false)

  const activeModal = useAppStore((s) => s.activeModal)
  const settings = useAppStore((s) => s.settings)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const featureTipsSeenIds = useAppStore((s) => s.featureTipsSeenIds)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const inNativeChatUpgradeTipAudience = useAppStore((s) =>
    isInNativeChatUpgradeTipAudience(s.nativeChatUpgradeTipVariant)
  )
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const actions = useAppStore(
    useShallow((s) => ({
      openModal: s.openModal,
      markFeatureTipsSeen: s.markFeatureTipsSeen,
      setNativeChatUpgradeTipVariant: s.setNativeChatUpgradeTipVariant,
      setContextualToursAutoEligible: s.setContextualToursAutoEligible,
      setContextualToursOnboardingVisible: s.setContextualToursOnboardingVisible
    }))
  )

  const applyStartupOnboardingState = useCallback((state: OnboardingState): void => {
    setOnboarding(state)
    setOnboardingLoaded(true)
  }, [])

  useEffect(() => {
    return onOnboardingReopened(setOnboarding)
  }, [])

  useEffect(() => {
    // Suppress tours during unknown onboarding so first-run users cannot consume them before onboarding.
    const suppressTours = !onboardingLoaded || shouldShowOnboarding(onboarding)
    actions.setContextualToursOnboardingVisible(suppressTours)
  }, [actions, onboarding, onboardingLoaded])

  useEffect(() => {
    if (!persistedUIReady || !onboardingLoaded || contextualToursAutoEligible !== null) {
      return
    }
    // Classify existing profiles once; auto-tour only first-run onboarding users.
    actions.setContextualToursAutoEligible(shouldShowOnboarding(onboarding))
  }, [actions, contextualToursAutoEligible, onboarding, onboardingLoaded, persistedUIReady])

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    let cancelled = false
    void window.api.cli
      .getInstallStatus()
      .then((status) => {
        if (cancelled) {
          return
        }
        setFeatureTipCliInstalled(isCliFeatureTipCompleted(status))
      })
      .catch(() => {
        if (!cancelled) {
          setFeatureTipCliInstalled(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [persistedUIReady])

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    let cancelled = false
    void window.api.onboarding
      .getNativeChatUpgradeTipVariant()
      .then((variant) => {
        if (!cancelled) {
          actions.setNativeChatUpgradeTipVariant(variant)
        }
      })
      .catch(() => {
        // Fail closed without holding other tips behind this read.
        if (!cancelled) {
          actions.setNativeChatUpgradeTipVariant('none')
        }
      })

    return () => {
      cancelled = true
    }
  }, [actions, persistedUIReady])

  useEffect(() => {
    const featureTipsDecision = getFeatureTipsAppOpenDecision({
      activeModal,
      cliInstalled: featureTipCliInstalled,
      featureTipsSeenIds,
      featureInteractions,
      inNativeChatUpgradeTipAudience,
      onboarding,
      persistedUIReady,
      promptedThisSession: promptedThisSessionRef.current,
      settings,
      suppressedByOnboardingThisSession: suppressedByOnboardingThisSessionRef.current,
      webClient: isWebClientLocation()
    })

    if (featureTipsDecision.kind === 'suppress-for-onboarding') {
      // Avoid a second education modal during first-run onboarding.
      suppressedByOnboardingThisSessionRef.current = true
      return
    }

    if (featureTipsDecision.kind !== 'open') {
      return
    }

    promptedThisSessionRef.current = true
    if (featureTipsDecision.tipId === 'orca-cli') {
      trackOrcaCliFeatureTipShown('app_open')
    } else if (featureTipsDecision.tipId === 'cmd-j-palette') {
      trackCmdJPaletteFeatureTipShown('app_open')
    }
    // Mark seen when shown so a crash before dismissal cannot repeat the tip.
    actions.markFeatureTipsSeen([featureTipsDecision.tipId])
    actions.openModal('feature-tips', {
      source: 'app_open',
      tipId: featureTipsDecision.tipId
    })
  }, [
    activeModal,
    actions,
    featureTipCliInstalled,
    featureInteractions,
    featureTipsSeenIds,
    inNativeChatUpgradeTipAudience,
    onboarding,
    persistedUIReady,
    settings
  ])

  const shouldRender = onboarding !== null && shouldShowOnboarding(onboarding)
  return useMemo(
    () => ({ applyStartupOnboardingState, onboarding, setOnboarding, shouldRender }),
    [applyStartupOnboardingState, onboarding, shouldRender]
  )
}
