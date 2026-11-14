import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { onOnboardingReopened } from '../components/onboarding/show-onboarding-event'
import { shouldShowOnboarding } from '../components/onboarding/should-show-onboarding'
import {
  getFeatureTipsAppOpenDecision,
  isCliFeatureTipCompleted
} from '../components/feature-tips/feature-tip-startup-gate'
import {
  shouldSuppressAutomaticChatUiLaunchTip,
  trackChatUiFeatureTipExposure,
  trackChatUiFeatureTipShown,
  trackCmdJPaletteFeatureTipShown,
  trackOrcaCliFeatureTipShown
} from '../components/feature-tips/feature-tip-telemetry'
import { useAppStore } from '../store/index'
import { isWebClientLocation } from './platform/web-client-location'
import type { OnboardingState } from '../../../shared/onboarding-state-types'

export type OnboardingGate = ReturnType<typeof useOnboardingAndFeatureTips>

/** Keep feature-tip education suppressed until onboarding state is known. */
export function useOnboardingAndFeatureTips() {
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null)
  const [onboardingLoadStatus, setOnboardingLoadStatus] = useState<'pending' | 'loaded' | 'failed'>(
    'pending'
  )
  const onboardingLoaded = onboardingLoadStatus === 'loaded'
  const [startupTourEligibility, setStartupTourEligibility] = useState<boolean | null>(null)
  const [featureTipCliInstalled, setFeatureTipCliInstalled] = useState<boolean | null>(null)
  const [chatUiHereCornerCardOpen, setChatUiHereCornerCardOpen] = useState(false)
  const [startupDecisionResolved, setStartupDecisionResolved] = useState(false)
  const promptedThisSessionRef = useRef(false)
  const suppressedByOnboardingThisSessionRef = useRef(false)

  const activeModal = useAppStore((s) => s.activeModal)
  const terminalStartupRestorationReady = useAppStore((s) => s.terminalStartupRestorationReady)
  // A queued SSH credential prompt is its own blocking surface (AppRootSurfaces), outside activeModal.
  const sshCredentialPending = useAppStore((s) => s.sshCredentialQueue.length > 0)
  const settings = useAppStore((s) => s.settings)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const featureTipsSeenIds = useAppStore((s) => s.featureTipsSeenIds)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const chatUiLaunchTipVariant = useAppStore((s) => s.chatUiLaunchTipVariant)
  const contextualToursAutoEligible = useAppStore((s) => s.contextualToursAutoEligible)
  const actions = useAppStore(
    useShallow((s) => ({
      openModal: s.openModal,
      markFeatureTipsSeen: s.markFeatureTipsSeen,
      setChatUiLaunchTipVariant: s.setChatUiLaunchTipVariant,
      setContextualToursAutoEligible: s.setContextualToursAutoEligible,
      setContextualToursOnboardingVisible: s.setContextualToursOnboardingVisible
    }))
  )

  const applyStartupOnboardingState = useCallback((state: OnboardingState): void => {
    setStartupTourEligibility((initial) => initial ?? shouldShowOnboarding(state))
    setOnboarding(state)
    setOnboardingLoadStatus('loaded')
  }, [])

  const applyStartupOnboardingFailure = useCallback((): void => {
    // Skip startup education without inventing or persisting completed onboarding.
    suppressedByOnboardingThisSessionRef.current = true
    setOnboardingLoadStatus('failed')
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
    if (
      !persistedUIReady ||
      startupTourEligibility === null ||
      contextualToursAutoEligible !== null
    ) {
      return
    }
    // Classify existing profiles once; auto-tour only first-run onboarding users.
    actions.setContextualToursAutoEligible(startupTourEligibility)
  }, [actions, contextualToursAutoEligible, startupTourEligibility, persistedUIReady])

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
      .getChatUiLaunchTipVariant()
      .then((variant) => {
        if (!cancelled) {
          actions.setChatUiLaunchTipVariant(variant)
        }
      })
      .catch(() => {
        // Fail closed without holding other tips behind this read.
        if (!cancelled) {
          actions.setChatUiLaunchTipVariant('none')
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
      chatUiLaunchTipVariant,
      onboarding,
      persistedUIReady,
      promptedThisSession: promptedThisSessionRef.current,
      settings,
      suppressedByOnboardingThisSession: suppressedByOnboardingThisSessionRef.current,
      webClient: isWebClientLocation()
    })

    if (featureTipsDecision.kind === 'suppress-for-onboarding') {
      // Avoid a second education modal during first-run onboarding.
      setStartupDecisionResolved(true)
      suppressedByOnboardingThisSessionRef.current = true
      return
    }

    if (featureTipsDecision.kind === 'skip') {
      setStartupDecisionResolved(true)
      return
    }
    if (featureTipsDecision.kind !== 'open') {
      return
    }

    if (featureTipsDecision.tipId === 'chat-ui-here' && chatUiLaunchTipVariant) {
      trackChatUiFeatureTipExposure(chatUiLaunchTipVariant, settings ?? null)
      if (shouldSuppressAutomaticChatUiLaunchTip(settings ?? null)) {
        // Suppressed profiles leave this launch available for the next pending tip.
        actions.markFeatureTipsSeen(['chat-ui-here'])
        return
      }
    }

    setStartupDecisionResolved(true)
    promptedThisSessionRef.current = true
    if (featureTipsDecision.tipId === 'orca-cli') {
      trackOrcaCliFeatureTipShown('app_open')
    } else if (featureTipsDecision.tipId === 'cmd-j-palette') {
      trackCmdJPaletteFeatureTipShown('app_open')
    } else if (featureTipsDecision.tipId === 'chat-ui-here' && chatUiLaunchTipVariant) {
      trackChatUiFeatureTipShown(chatUiLaunchTipVariant)
    }
    // Mark seen when shown so a crash before dismissal cannot repeat the tip.
    actions.markFeatureTipsSeen([featureTipsDecision.tipId])
    if (featureTipsDecision.tipId === 'chat-ui-here' && chatUiLaunchTipVariant === 'chat-ui-off') {
      // Terminal-default profiles get the nonblocking card; chat users still acknowledge the modal.
      setChatUiHereCornerCardOpen(true)
      return
    }
    actions.openModal('feature-tips', {
      source: 'app_open',
      tipId: featureTipsDecision.tipId
    })
  }, [
    activeModal,
    actions,
    chatUiLaunchTipVariant,
    featureTipCliInstalled,
    featureInteractions,
    featureTipsSeenIds,
    onboarding,
    persistedUIReady,
    settings
  ])

  const shouldRender = onboarding !== null && shouldShowOnboarding(onboarding)
  const startupPromptsFinished =
    (onboardingLoadStatus === 'failed'
      ? terminalStartupRestorationReady
      : startupDecisionResolved && onboardingLoaded) &&
    !shouldRender &&
    !chatUiHereCornerCardOpen &&
    !sshCredentialPending &&
    activeModal === 'none'
  return useMemo(
    () => ({
      applyStartupOnboardingState,
      applyStartupOnboardingFailure,
      onboarding,
      setOnboarding,
      shouldRender,
      startupPromptsFinished,
      chatUiHereCornerCardOpen,
      setChatUiHereCornerCardOpen
    }),
    [
      applyStartupOnboardingState,
      applyStartupOnboardingFailure,
      onboarding,
      shouldRender,
      startupPromptsFinished,
      chatUiHereCornerCardOpen
    ]
  )
}
