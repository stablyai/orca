import { Alert } from 'react-native'
import type {
  MobileWebNativeAlertPayload,
  MobileWebNativeAlertResult
} from '../../../src/shared/mobile-web/native-operation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

type MobileWebNativeAlertTarget = Pick<typeof Alert, 'alert'>

export function presentMobileWebNativeAlert(
  payload: MobileWebNativeAlertPayload,
  target: MobileWebNativeAlertTarget = Alert
): Promise<MobileWebNativeAlertResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: MobileWebNativeAlertResult): void => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    target.alert(
      payload.title,
      payload.message,
      payload.buttons.map((button, buttonIndex) => ({
        ...button,
        onPress: () => settle({ kind: 'button', buttonIndex })
      })),
      {
        ...payload.options,
        onDismiss: () => settle({ kind: 'dismissed' })
      }
    )
  })
}

export class MobileWebNativeAlertLifecycle {
  private pending: Promise<void> | null = null

  readonly present = (
    payload: MobileWebNativeAlertPayload,
    target: MobileWebNativeAlertTarget = Alert
  ): Promise<MobileWebNativeAlertResult> => {
    if (this.pending) {
      return Promise.reject(new MobileWebBrokerError('rate_limited'))
    }
    const result = presentMobileWebNativeAlert(payload, target)
    const pending = result.then(
      () => undefined,
      () => undefined
    )
    this.pending = pending
    void pending.then(() => {
      if (this.pending === pending) {
        this.pending = null
      }
    })
    return result
  }

  readonly waitForIdle = async (): Promise<void> => {
    await this.pending
  }
}

export const mobileWebNativeAlertLifecycle = new MobileWebNativeAlertLifecycle()
