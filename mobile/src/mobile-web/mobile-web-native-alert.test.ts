import type { Alert, AlertButton } from 'react-native'
import { describe, expect, it, vi } from 'vitest'
import {
  MobileWebNativeAlertLifecycle,
  presentMobileWebNativeAlert
} from './mobile-web-native-alert'

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }))

describe('mobile web native alert', () => {
  it('preserves native button/options presentation and correlates the selected index', async () => {
    let buttons: AlertButton[] = []
    let options: Parameters<typeof Alert.alert>[3]
    const target = {
      alert: vi.fn((_title, _message, nextButtons, nextOptions) => {
        buttons = nextButtons ?? []
        options = nextOptions
      })
    }
    const result = presentMobileWebNativeAlert(
      {
        title: 'Discard changes?',
        message: 'Unsaved edits will be lost.',
        buttons: [
          { text: 'Stay', style: 'cancel' },
          { text: 'Discard', style: 'destructive', isPreferred: true }
        ],
        options: { cancelable: false, userInterfaceStyle: 'dark' }
      },
      target
    )

    expect(target.alert).toHaveBeenCalledWith(
      'Discard changes?',
      'Unsaved edits will be lost.',
      expect.any(Array),
      expect.objectContaining({ cancelable: false, userInterfaceStyle: 'dark' })
    )
    buttons[1]?.onPress?.()
    options?.onDismiss?.()
    await expect(result).resolves.toEqual({ kind: 'button', buttonIndex: 1 })
  })

  it('reports an outside/back dismissal when the native platform allows it', async () => {
    let options: Parameters<typeof Alert.alert>[3]
    const target = {
      alert: vi.fn((_title, _message, _buttons, nextOptions) => {
        options = nextOptions
      })
    }
    const result = presentMobileWebNativeAlert(
      {
        title: 'Notice',
        buttons: [{ text: 'OK' }],
        options: { cancelable: true }
      },
      target
    )

    options?.onDismiss?.()
    await expect(result).resolves.toEqual({ kind: 'dismissed' })
  })

  it('serializes native alerts across broker lifecycles', async () => {
    let buttons: AlertButton[] = []
    let options: Parameters<typeof Alert.alert>[3]
    const target = {
      alert: vi.fn((_title, _message, nextButtons, nextOptions) => {
        buttons = nextButtons ?? []
        options = nextOptions
      })
    }
    const lifecycle = new MobileWebNativeAlertLifecycle()
    const first = lifecycle.present({ title: 'First', buttons: [{ text: 'OK' }] }, target)

    await expect(
      lifecycle.present({ title: 'Second', buttons: [{ text: 'OK' }] }, target)
    ).rejects.toMatchObject({ code: 'rate_limited' })
    let idle = false
    const waiting = lifecycle.waitForIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    expect(idle).toBe(false)

    buttons[0]?.onPress?.()
    options?.onDismiss?.()
    await expect(first).resolves.toEqual({ kind: 'button', buttonIndex: 0 })
    await waiting
    expect(idle).toBe(true)

    const third = lifecycle.present({ title: 'Third', buttons: [{ text: 'OK' }] }, target)
    options?.onDismiss?.()
    await expect(third).resolves.toEqual({ kind: 'dismissed' })
  })
})
