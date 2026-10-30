import { AppState } from 'react-native'
import { refreshPushConsent } from './push-consent-preparation'
import {
  prepareNativePushToken,
  qualifyNativePushToken,
  observeNativePushToken,
  settleTokenPreparations,
  type TokenPreparation
} from './push-native-preparation'
import { startMobilePushLeaseRenewal } from './mobile-push-lease-renewal'
import { addPushTokenListener, type MobilePushToken } from './push-token'
import { startPushRoutePublication, type PushRoutePublication } from './push-route-declaration'

export type MobilePushOwner = ReturnType<typeof createMobilePushOwner>

export function createMobilePushOwner(
  current: () => boolean,
  generation: () => number,
  localIntentSettled: () => boolean,
  retireObsoletePreparations: () => void,
  changed: () => void
) {
  let active = true
  let enabled: boolean | undefined
  let stopLease = () => {}
  let stopToken = () => {}
  let stopConsent = () => {}
  let nativeInterest: (() => void) | undefined
  let observation: object = {}
  let renewalWake = false
  const root: {
    token: MobilePushToken | null
    readonly enabled: boolean | undefined
    intent: number
    renewal: number
    publication: PushRoutePublication
    isCurrent(): boolean
    invalidate(): void
    rederive(): void
    refresh(): void
    acceptHostConsent(enabled: boolean): void
    prepareCurrentToken(isCurrent: () => boolean): TokenPreparation
    start(): void
    stop(): void
  } = {
    token: null,
    get enabled() {
      return enabled
    },
    intent: generation(),
    renewal: 0,
    publication: startPushRoutePublication(() =>
      root.isCurrent() && root.enabled && root.token
        ? { token: root.token, intent: root.intent }
        : undefined
    ),
    isCurrent: (): boolean =>
      active && current() && localIntentSettled() && root.intent === generation(),
    invalidate() {
      enabled = undefined
      stopConsent()
      retireNative()
      changed()
      root.publication.wake('input')
    },
    rederive() {
      root.intent = generation()
      refresh()
    },
    refresh,
    acceptHostConsent(value: boolean) {
      applyConsent(value, false)
    },
    prepareCurrentToken(isCurrent: () => boolean) {
      return prepareNativePushToken(isCurrent, () => root.token)
    },
    start() {
      stopLease = startMobilePushLeaseRenewal(
        async () => {
          if (!root.isCurrent()) {
            return
          }
          root.renewal++
          renewalWake = true
          changed()
          refresh()
        },
        () => {
          retireNative()
          changed()
        }
      )
      stopToken = addPushTokenListener((token) => {
        if (!active || !current()) {
          return
        }
        observation = {}
        observeNativePushToken()
        retireNative()
        root.token = token
        settleTokenPreparations()
        changed()
        refresh()
      })
      refresh()
      changed()
    },
    stop() {
      active = false
      stopConsent()
      retireNative()
      changed()
      root.publication.stop()
      stopLease()
      stopToken()
    }
  }
  function retireNative(): void {
    nativeInterest?.()
    nativeInterest = undefined
    settleTokenPreparations()
    retireObsoletePreparations()
  }
  function applyConsent(value: boolean, mayStart: boolean): void {
    enabled = value
    if (!value) {
      retireNative()
      return
    }
    if (root.isCurrent() && AppState.currentState === 'active' && !root.token && !nativeInterest) {
      const intent = root.intent
      const observed = observation
      const valid = () =>
        root.isCurrent() &&
        root.intent === intent &&
        observed === observation &&
        enabled === true &&
        AppState.currentState === 'active'
      const interest = qualifyNativePushToken(
        valid,
        (token) => {
          if (nativeInterest === interest) {
            nativeInterest = undefined
          }
          if (valid()) {
            root.token = token
            changed()
            project()
          }
        },
        mayStart
      )
      nativeInterest = interest
    }
  }
  function project(): void {
    if (!root.isCurrent()) {
      return
    }
    root.publication.wake(renewalWake ? 'renewal' : 'input')
    renewalWake = false
    if (root.token && enabled) {
      changed()
    }
  }
  function refresh(): void {
    const observed = observation
    const intent = root.intent
    const valid = () => root.isCurrent() && root.intent === intent && observation === observed
    stopConsent = refreshPushConsent(valid, (preference) => {
      if (!valid()) {
        return
      }
      applyConsent(preference.value ?? false, true)
      project()
    })
  }
  return root
}
