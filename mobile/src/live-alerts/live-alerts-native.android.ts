import { OrcaLiveAlerts } from '../../modules/orca-live-alerts/src'
import type { LiveAlertsNativeAdapter } from './live-alert-types'

function createAdapter(): LiveAlertsNativeAdapter | null {
  const native = OrcaLiveAlerts
  if (!native) {
    return null
  }
  return {
    capabilities: () => {
      try {
        return native.getCapabilities()
      } catch {
        return null
      }
    },
    show: (payload) => native.show(JSON.stringify(payload)),
    finish: (payload) => native.finish(payload ? JSON.stringify(payload) : null),
    cancel: () => native.cancel(),
    subscribeTick: (listener) => {
      const subscription = native.addListener('onTick', listener)
      return () => subscription.remove()
    },
    subscribeDismissed: (listener) => {
      const subscription = native.addListener('onDismissed', listener)
      return () => subscription.remove()
    },
    subscribeTaps: (listener) => {
      const deliver = (target: string | null) => {
        if (!target) {
          return
        }
        try {
          listener(JSON.parse(target))
        } catch {
          // A malformed target opens nothing; the tap still brought the app forward.
        }
      }
      const subscription = native.addListener('onOpenTarget', (event) => deliver(event.target))
      deliver(native.consumeLaunchTarget())
      return () => subscription.remove()
    },
    openPromotionSettings: () => native.openPromotionSettings(),
    openAppNotificationSettings: () => native.openAppNotificationSettings(),
    openAppDetailsSettings: () => native.openAppDetailsSettings()
  }
}

export const liveAlertsNative: LiveAlertsNativeAdapter | null = createAdapter()
