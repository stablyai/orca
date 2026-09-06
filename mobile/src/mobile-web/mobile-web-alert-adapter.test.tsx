import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MobileWebAlertAdapter,
  createMobileWebAlertController,
  installMobileWebAlertAdapter
} from './mobile-web-alert-adapter'

vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: 'ConfirmModal' }))

describe('mobile web Alert adapter', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the native confirmation copy and invokes only the chosen action', () => {
    const stay = vi.fn()
    const discard = vi.fn()
    const target = { alert: vi.fn() }
    expect(installMobileWebAlertAdapter(target)).toBe(true)
    act(() => {
      renderer = create(createElement(MobileWebAlertAdapter))
      target.alert('Discard changes?', 'Unsaved edits will be lost.', [
        { text: 'Stay', style: 'cancel', onPress: stay },
        { text: 'Discard', style: 'destructive', onPress: discard }
      ])
    })

    const modal = renderer.root.findByType('ConfirmModal')
    expect(modal.props).toMatchObject({
      title: 'Discard changes?',
      message: 'Unsaved edits will be lost.',
      cancelLabel: 'Stay',
      confirmLabel: 'Discard',
      destructive: true
    })
    act(() => {
      modal.props.onConfirm()
      modal.props.onCancel()
    })
    expect(discard).toHaveBeenCalledOnce()
    expect(stay).not.toHaveBeenCalled()
  })

  it('queues alerts and supplies the native implicit OK action', () => {
    const controller = createMobileWebAlertController()
    controller.alert('First')
    controller.alert('Second')

    const first = controller.getSnapshot()
    expect(first).toMatchObject({ title: 'First', buttons: [{ text: 'OK' }] })
    controller.choose(first!.id, first!.buttons[0])
    expect(controller.getSnapshot()).toMatchObject({ title: 'Second' })
  })

  it('bounds queued alerts', () => {
    const controller = createMobileWebAlertController()
    for (let index = 0; index < 20; index += 1) {
      controller.alert(`Alert ${index}`)
    }

    const titles: string[] = []
    while (controller.getSnapshot()) {
      const prompt = controller.getSnapshot()!
      titles.push(prompt.title)
      controller.choose(prompt.id, prompt.buttons[0])
    }
    expect(titles).toEqual(Array.from({ length: 16 }, (_, index) => `Alert ${index}`))
  })

  it('uses the negotiated native alert and returns only the selected button callback', async () => {
    const cancel = vi.fn()
    const confirm = vi.fn()
    const presentNative = vi.fn().mockResolvedValue({ kind: 'button', buttonIndex: 1 })
    const target = { alert: vi.fn() }
    installMobileWebAlertAdapter(target)

    await act(async () => {
      renderer = create(createElement(MobileWebAlertAdapter, { presentNative }))
      target.alert(
        'Use reset?',
        'This spends one reset.',
        [
          { text: 'Cancel', style: 'cancel', onPress: cancel },
          { text: 'Use reset', isPreferred: true, onPress: confirm }
        ],
        { cancelable: false, userInterfaceStyle: 'dark' }
      )
      await Promise.resolve()
    })

    expect(presentNative).toHaveBeenCalledWith({
      title: 'Use reset?',
      message: 'This spends one reset.',
      buttons: [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Use reset', isPreferred: true }
      ],
      options: { cancelable: false, userInterfaceStyle: 'dark' }
    })
    expect(confirm).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
    expect(renderer.toJSON()).toBeNull()
  })

  it('returns native dismissals and falls back only when the capability is unavailable', async () => {
    const onDismiss = vi.fn()
    const target = { alert: vi.fn() }
    installMobileWebAlertAdapter(target)
    const presentNative = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'dismissed' })
      .mockRejectedValueOnce(new Error('unsupported_capability'))

    await act(async () => {
      renderer = create(createElement(MobileWebAlertAdapter, { presentNative }))
      target.alert('First', undefined, undefined, { onDismiss })
      await Promise.resolve()
    })
    expect(onDismiss).toHaveBeenCalledOnce()

    await act(async () => {
      target.alert('Second')
      await Promise.resolve()
    })
    expect(renderer.root.findByType('ConfirmModal').props).toMatchObject({
      title: 'Second',
      confirmLabel: 'OK'
    })
    act(() => renderer!.root.findByType('ConfirmModal').props.onConfirm())
  })

  it('keeps native presentation ownership across adapter remounts', async () => {
    let resolveResult!: (result: { kind: 'button'; buttonIndex: number }) => void
    const presentNative = vi.fn(
      () =>
        new Promise<{ kind: 'button'; buttonIndex: number }>((resolve) => {
          resolveResult = resolve
        })
    )
    const pressed = vi.fn()
    const target = { alert: vi.fn() }
    installMobileWebAlertAdapter(target)

    act(() => {
      renderer = create(createElement(MobileWebAlertAdapter, { presentNative }))
      target.alert('Deferred', undefined, [{ text: 'Done', onPress: pressed }])
    })
    act(() => renderer!.unmount())
    act(() => {
      renderer = create(createElement(MobileWebAlertAdapter, { presentNative }))
    })
    expect(presentNative).toHaveBeenCalledOnce()

    await act(async () => {
      resolveResult({ kind: 'button', buttonIndex: 0 })
      await Promise.resolve()
    })
    expect(pressed).toHaveBeenCalledOnce()
    expect(renderer.toJSON()).toBeNull()
  })

  it('dismisses an Android-cancelable fallback without pressing its first button', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Android' })
    const first = vi.fn()
    const second = vi.fn()
    const onDismiss = vi.fn()
    const target = { alert: vi.fn() }
    installMobileWebAlertAdapter(target)

    act(() => {
      renderer = create(createElement(MobileWebAlertAdapter))
      target.alert(
        'Choose',
        undefined,
        [
          { text: 'First', onPress: first },
          { text: 'Second', onPress: second }
        ],
        { cancelable: true, onDismiss }
      )
    })

    const modal = renderer.root.findByType('ConfirmModal')
    expect(modal.props.dismissible).toBe(true)
    act(() => modal.props.onDismiss())
    expect(onDismiss).toHaveBeenCalledOnce()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('keeps non-cancelable fallbacks modal while explicit secondary actions still work', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Android' })
    const first = vi.fn()
    const second = vi.fn()
    const onDismiss = vi.fn()
    const target = { alert: vi.fn() }
    installMobileWebAlertAdapter(target)

    act(() => {
      renderer = create(createElement(MobileWebAlertAdapter))
      target.alert(
        'Choose',
        undefined,
        [
          { text: 'First', onPress: first },
          { text: 'Second', onPress: second }
        ],
        { cancelable: false, onDismiss }
      )
    })

    const modal = renderer.root.findByType('ConfirmModal')
    expect(modal.props.dismissible).toBe(false)
    act(() => modal.props.onCancel())
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
