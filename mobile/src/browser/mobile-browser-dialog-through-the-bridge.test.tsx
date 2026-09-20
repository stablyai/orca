/**
 * The pane's dialog card against a host that answers the way Chromium does.
 *
 * Measured on Chromium 1217, 2026-09-20: a page that opens a dialog runs nothing else until the
 * dialog is answered, and `Page.javascriptDialogClosed` is what says it was. So the card is the
 * page's block, not a local overlay — closing it on the press reports an answer the page never
 * got, and hides a page that is still waiting.
 */
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { createBridgePortPair } from '../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { MobileBrowserPane, type MobileBrowserTab } from './MobileBrowserPane'

vi.mock('./use-browser-binary-screencast-grant', () => ({
  useBrowserBinaryScreencastGrant: vi.fn(() => true)
}))

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Image: 'Image',
  PanResponder: { create: () => ({ panHandlers: {} }) },
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  StyleSheet: {
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Monitor: 'Monitor',
  RefreshCw: 'RefreshCw',
  Smartphone: 'Smartphone'
}))

const TAB: MobileBrowserTab = {
  type: 'browser',
  id: 'tab-1',
  title: 'Dialogs',
  browserWorkspaceId: 'bw-1',
  browserPageId: 'page-1',
  url: 'https://dialogs.example/',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  isActive: true
}

/**
 * A page that runs `alert('first')` and then `confirm('second')`, stopped at each one.
 *
 * `answer` is the only thing that moves it, which is the property the product has to hold: the
 * card may not clear until this has run.
 */
function createBlockedPage(emit: (event: unknown) => void) {
  let step = 0
  let confirmValue: boolean | null = null
  const run = (): void => {
    step += 1
    if (step === 1) {
      emit({ type: 'dialog', dialogType: 'alert', message: 'first' })
    } else if (step === 2) {
      emit({ type: 'dialog', dialogType: 'confirm', message: 'second' })
    }
  }
  return {
    start: run,
    answer: (accept: boolean): void => {
      if (step === 2) {
        confirmValue = accept
      }
      emit({ type: 'dialogClosed' })
      run()
    },
    confirmValue: (): boolean | null => confirmValue
  }
}

/** Host components are strings under the react-native double, which `findAllByType` will not take. */
function nodesOfType(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll((node) => node.type === type)
}

function cardMessages(renderer: ReactTestRenderer): string[] {
  return nodesOfType(renderer.root, 'Text')
    .map((node) => node.props.children)
    .filter((child): child is string => typeof child === 'string')
}

function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const button = nodesOfType(renderer.root, 'Pressable').find((node) =>
    nodesOfType(node, 'Text').some((text) => text.props.children === label)
  )
  if (!button) {
    throw new Error(`no ${label} button on screen`)
  }
  return button
}

function pressButton(renderer: ReactTestRenderer, label: string): void {
  const button = findButton(renderer, label)
  act(() => {
    button.props.onPress()
  })
}

async function openPaneOverTheBridge() {
  const rpc = createFakeRpcClient()
  const pair = createBridgePortPair({ rpc, routeGrants: ['screencastBinary'] })
  await pair.flush()
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(
      createElement(MobileBrowserPane, {
        client: pair.client,
        worktreeId: 'worktree-1',
        tab: TAB,
        screencastSupported: true,
        keyboardLift: 0,
        bottomInset: 0,
        onToast: () => {}
      }),
      { createNodeMock: () => ({ setNativeProps: () => {} }) }
    )
    await Promise.resolve()
  })
  const viewport = nodesOfType(renderer.root, 'View').find(
    (node) => typeof node.props.onLayout === 'function'
  )
  act(() => {
    viewport?.props.onLayout({ nativeEvent: { layout: { width: 402, height: 593 } } })
  })
  await pair.flush()
  const stream = rpc.streams.find((entry) => entry.method === 'browser.screencast')
  if (!stream) {
    throw new Error('the pane did not subscribe to browser.screencast through the bridge')
  }
  const page = createBlockedPage((event) => {
    stream.emit(event)
  })
  const flush = async (): Promise<void> => {
    await act(async () => {
      await pair.flush()
    })
  }
  /** Settles the dialog reply the pane sent, the way a host that reached the stream would. */
  const answerFromTheHost = async (accept: boolean): Promise<void> => {
    const request = rpc.requests.at(-1)
    if (!request || !request.method.startsWith('browser.dialog')) {
      throw new Error(`the pane's last request was ${request?.method ?? 'nothing'}`)
    }
    await act(async () => {
      request.resolve(rpcSuccess(`req-${rpc.requests.length}`, {}))
      page.answer(accept)
      await pair.flush()
    })
  }
  return { answerFromTheHost, flush, page, renderer, rpc }
}

describe('the pane keeps its dialog card until the page is unblocked', () => {
  it('raises the second dialog and answers the confirm with OK', async () => {
    const pane = await openPaneOverTheBridge()
    await act(async () => {
      pane.page.start()
      await pane.flush()
    })
    expect(cardMessages(pane.renderer)).toContain('first')

    pressButton(pane.renderer, 'OK')
    await pane.flush()
    // The host has the reply and has not answered the page. The alert is still up on the page,
    // so it is still up here.
    expect(cardMessages(pane.renderer)).toContain('first')

    await pane.answerFromTheHost(true)
    // The page moved on, so the card did too: the confirm, with a Cancel beside the OK.
    expect(cardMessages(pane.renderer)).toContain('second')
    expect(cardMessages(pane.renderer)).not.toContain('first')
    expect(cardMessages(pane.renderer)).toContain('Cancel')

    pressButton(pane.renderer, 'OK')
    await pane.flush()
    await pane.answerFromTheHost(true)
    expect(pane.page.confirmValue()).toBe(true)
    expect(cardMessages(pane.renderer)).not.toContain('second')
  })

  it('keeps the card pressable and says so when the answer does not reach the page', async () => {
    const pane = await openPaneOverTheBridge()
    await act(async () => {
      pane.page.start()
      await pane.flush()
    })
    expect(cardMessages(pane.renderer)).toContain('first')

    pressButton(pane.renderer, 'OK')
    await pane.flush()
    const refused = pane.rpc.requests.at(-1)
    await act(async () => {
      refused?.reject(new Error('the host refused'))
      await pane.flush()
    })

    // The page never took the answer, so the alert is still up and the card says why.
    expect(cardMessages(pane.renderer)).toContain('first')
    expect(cardMessages(pane.renderer)).toContain('That answer did not reach the page.')

    // And the button still works: the retry reaches the host, which answers, and the page moves on.
    pressButton(pane.renderer, 'OK')
    await pane.flush()
    await pane.answerFromTheHost(true)
    expect(cardMessages(pane.renderer)).toContain('second')
    expect(cardMessages(pane.renderer)).not.toContain('That answer did not reach the page.')
  })

  it('kills the card buttons while an answer is in flight, so a double tap sends one', async () => {
    const pane = await openPaneOverTheBridge()
    await act(async () => {
      pane.page.start()
      await pane.flush()
    })

    pressButton(pane.renderer, 'OK')
    await pane.flush()
    const inFlight = pane.rpc.requests.length
    // The host takes one answer per dialog: a second would be refused, or would settle the page's
    // next dialog unseen. The button is what stops the second tap from ever being sent.
    expect(findButton(pane.renderer, 'OK').props.disabled).toBe(true)

    await pane.answerFromTheHost(true)
    expect(pane.rpc.requests.length).toBe(inFlight)
    // The next dialog arrives with live buttons of its own.
    expect(cardMessages(pane.renderer)).toContain('second')
    expect(findButton(pane.renderer, 'OK').props.disabled).toBe(false)
    expect(findButton(pane.renderer, 'Cancel').props.disabled).toBe(false)
  })

  it('stamps the failure on the dialog that was answered, never on the one that replaced it', async () => {
    const pane = await openPaneOverTheBridge()
    await act(async () => {
      pane.page.start()
      await pane.flush()
    })
    expect(cardMessages(pane.renderer)).toContain('first')

    pressButton(pane.renderer, 'OK')
    await pane.flush()
    const answeringFirst = pane.rpc.requests.at(-1)

    // The page moves on without the pane hearing about it: the alert was settled and the confirm
    // raised, but the reply to that first answer is still out there.
    await act(async () => {
      pane.page.answer(true)
      await pane.flush()
    })
    expect(cardMessages(pane.renderer)).toContain('second')

    // Now it times out. It belongs to the alert, which is gone, so the confirm must not wear it.
    await act(async () => {
      answeringFirst?.reject(new Error('timed out after 5000ms'))
      await pane.flush()
    })

    expect(cardMessages(pane.renderer)).toContain('second')
    expect(cardMessages(pane.renderer)).not.toContain('That answer did not reach the page.')
    expect(findButton(pane.renderer, 'OK').props.disabled).toBe(false)
    expect(findButton(pane.renderer, 'Cancel').props.disabled).toBe(false)
  })

  it('answers the confirm with Cancel', async () => {
    const pane = await openPaneOverTheBridge()
    await act(async () => {
      pane.page.start()
      await pane.flush()
    })
    pressButton(pane.renderer, 'OK')
    await pane.flush()
    await pane.answerFromTheHost(true)

    pressButton(pane.renderer, 'Cancel')
    await pane.flush()
    expect(pane.rpc.requests.at(-1)?.method).toBe('browser.dialogDismiss')
    await pane.answerFromTheHost(false)
    expect(pane.page.confirmValue()).toBe(false)
    expect(cardMessages(pane.renderer)).not.toContain('second')
  })
})
