import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))

import type { BrowserManager } from './browser-manager'
import { CdpBridge } from './cdp-bridge'
import type { CdpCommandSender, RefEntry } from './snapshot-engine'

type InteractabilityOptions = {
  disabledBySelector?: boolean
  evaluationException?: boolean
  parentAriaDisabled?: boolean
  regularHitDescendant?: boolean
  shadowHostInert?: boolean
  slottedHitDescendant?: boolean
  slottedInertWrapper?: boolean
}

type TestGuest = {
  id: number
  debugger: { sendCommand: ReturnType<typeof vi.fn> }
}

type AttachGuest = TestGuest & {
  debugger: TestGuest['debugger'] & {
    attach: ReturnType<typeof vi.fn>
    isAttached: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
  }
}

type CdpBridgeInternals = {
  assertElementInteractable(
    sender: CdpCommandSender,
    backendNodeId: number,
    ref: string,
    requirements: { pointerCenter?: { cx: number; cy: number }; requireEnabled?: boolean }
  ): Promise<void>
  ensureDebuggerAttached(guest: AttachGuest): Promise<void>
  getElementCenter(
    sender: CdpCommandSender,
    backendNodeId: number,
    ref?: string
  ): Promise<{ cx: number; cy: number }>
  getPageCoordinates(
    guest: TestGuest,
    refEntry: RefEntry,
    localCx: number,
    localCy: number
  ): Promise<{ cx: number; cy: number }>
  tabState: Map<
    string,
    {
      iframeSessions: Map<string, string>
      iframeParentSessions?: Map<string, string | null>
    }
  >
}

function createBridge(): CdpBridgeInternals {
  const browserManager = {
    webContentsIdByTabId: new Map([['tab-1', 11]])
  } as unknown as BrowserManager
  return new CdpBridge(browserManager) as unknown as CdpBridgeInternals
}

function createInteractabilitySender(options: InteractabilityOptions): CdpCommandSender {
  return vi.fn(async (method, params) => {
    if (method === 'DOM.requestNode') {
      return { nodeId: 1 }
    }
    if (method === 'DOM.resolveNode') {
      return { object: { objectId: 'target-1' } }
    }
    if (method !== 'Runtime.callFunctionOn') {
      throw new Error(`Unexpected command: ${method}`)
    }

    const declaration = String(params?.functionDeclaration)
    const compile = new Function('getComputedStyle', `return (${declaration})`)
    const check = compile(() => ({
      display: 'block',
      visibility: 'visible'
    })) as (this: Record<string, unknown>, ...args: unknown[]) => string
    const ariaParent = {
      parentElement: null,
      getAttribute: (name: string) =>
        name === 'aria-disabled' && options.parentAriaDisabled ? 'true' : null,
      inert: false
    }
    const shadowHost = {
      parentElement: null,
      getAttribute: () => null,
      inert: options.shadowHostInert === true
    }
    const slotWrapper = {
      parentElement: null,
      getAttribute: () => null,
      inert: options.slottedInertWrapper === true
    }
    const slot = {
      parentElement: slotWrapper,
      getAttribute: () => null,
      inert: false
    }
    const hitDescendant: Record<string, unknown> = {}
    const ownerDocument = {
      elementFromPoint: () =>
        options.regularHitDescendant || options.slottedHitDescendant ? hitDescendant : target
    }
    const target: Record<string, unknown> = {
      disabled: false,
      inert: false,
      readOnly: false,
      hidden: false,
      type: 'button',
      tagName: 'BUTTON',
      isContentEditable: false,
      matches: (selector: string) =>
        selector === ':disabled' && options.disabledBySelector === true,
      getAttribute: () => null,
      parentElement: options.parentAriaDisabled ? ariaParent : null,
      assignedSlot: options.slottedInertWrapper ? slot : null,
      ownerDocument
    }
    target.getRootNode = () =>
      options.shadowHostInert || options.slottedHitDescendant
        ? {
            host: shadowHost,
            elementFromPoint: () => (options.slottedHitDescendant ? hitDescendant : target)
          }
        : ownerDocument
    if (options.regularHitDescendant) {
      hitDescendant.parentElement = target
    }
    if (options.slottedHitDescendant) {
      hitDescendant.assignedSlot = { parentElement: target }
    }
    const values = ((params?.arguments ?? []) as { value: unknown }[]).map(({ value }) => value)
    if (options.evaluationException) {
      return { result: {}, exceptionDetails: { text: 'Uncaught TypeError' } }
    }
    return { result: { value: check.call(target, ...values) } }
  })
}

function createIframeHarness(options?: {
  covered?: boolean
  nested?: boolean
  ownerMissingLayout?: boolean
  perspective?: boolean
  transformed?: boolean
}): {
  bridge: CdpBridgeInternals
  guest: TestGuest
  sendCommand: ReturnType<typeof vi.fn>
} {
  const bridge = createBridge()
  bridge.tabState.set('tab-1', {
    iframeSessions: new Map(
      options?.nested
        ? [
            ['target-1', 'session-1'],
            ['target-2', 'session-2']
          ]
        : [['target-2', 'session-2']]
    ),
    iframeParentSessions: new Map(
      options?.nested
        ? [
            ['session-1', null],
            ['session-2', 'session-1']
          ]
        : [['session-2', null]]
    )
  })
  const sendCommand = vi.fn(
    async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      if (method === 'Page.getFrameTree' && sessionId === 'session-2') {
        return { frameTree: { frame: { id: 'frame-2' } } }
      }
      if (method === 'Page.getFrameTree' && sessionId === 'session-1') {
        return { frameTree: { frame: { id: 'frame-1' } } }
      }
      if (method === 'DOM.getFrameOwner') {
        if (params?.frameId === 'frame-2') {
          if (options?.nested && sessionId !== 'session-1') {
            throw new Error('Frame with the given id does not belong to the target.')
          }
          return { backendNodeId: 202 }
        }
        expect(params).toEqual({ frameId: 'frame-1' })
        expect(sessionId).toBeUndefined()
        return { backendNodeId: 101 }
      }
      if (method === 'DOM.getBoxModel') {
        if (options?.ownerMissingLayout) {
          throw new Error('Could not compute box model.')
        }
        if (params?.backendNodeId === 202) {
          if (options?.nested) {
            expect(sessionId).toBe('session-1')
            return { model: { content: [50, 40, 250, 40, 250, 140, 50, 140] } }
          }
          const content = options?.perspective
            ? [150, 100, 282.762, 100, 282.762, 273.598, 150, 400]
            : options?.transformed
              ? [200, 100, 800, 100, 800, 500, 200, 500]
              : [200, 100, 400, 100, 400, 200, 200, 200]
          return { model: { content } }
        }
        expect(params).toEqual({ backendNodeId: 101 })
        return { model: { content: [200, 100, 600, 100, 600, 300, 200, 300] } }
      }
      if (method === 'Page.getLayoutMetrics') {
        const size = options?.perspective
          ? { clientWidth: 400, clientHeight: 300 }
          : sessionId === 'session-2'
            ? { clientWidth: 200, clientHeight: 100 }
            : { clientWidth: 400, clientHeight: 200 }
        return { cssLayoutViewport: size }
      }
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'iframe-2' } }
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: options?.covered !== true } }
      }
      throw new Error(`Unexpected command: ${method}`)
    }
  )
  return { bridge, guest: { id: 11, debugger: { sendCommand } }, sendCommand }
}

describe('CDP element actionability', () => {
  it('records each iframe session immediate parent from debugger events', async () => {
    const bridge = createBridge()
    let messageListener:
      | ((_event: unknown, method: string, params: unknown, sessionId?: string) => void)
      | undefined
    const sendCommand = vi.fn(
      async (_method: string, _params?: Record<string, unknown>, sessionId?: string) => {
        if (_method === 'Target.setAutoAttach' && !sessionId) {
          messageListener?.(
            {},
            'Target.attachedToTarget',
            { sessionId: 'session-1', targetInfo: { type: 'iframe', targetId: 'target-1' } },
            undefined
          )
        }
        if (_method === 'Target.setAutoAttach' && sessionId === 'session-1') {
          messageListener?.(
            {},
            'Target.attachedToTarget',
            { sessionId: 'session-2', targetInfo: { type: 'iframe', targetId: 'target-2' } },
            'session-1'
          )
        }
        return {}
      }
    )
    const guest: AttachGuest = {
      id: 11,
      debugger: {
        attach: vi.fn(),
        isAttached: vi.fn(() => false),
        on: vi.fn((event: string, listener: typeof messageListener) => {
          if (event === 'message') {
            messageListener = listener
          }
        }),
        removeListener: vi.fn(),
        sendCommand
      }
    }
    await bridge.ensureDebuggerAttached(guest)

    expect(bridge.tabState.get('tab-1')?.iframeParentSessions).toEqual(
      new Map([
        ['session-1', null],
        ['session-2', 'session-1']
      ])
    )
    expect(sendCommand).toHaveBeenCalledWith(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      'session-2'
    )
  })

  it('uses a non-zero border quad when the content quad is empty', async () => {
    const sender: CdpCommandSender = vi.fn(async () => ({
      model: {
        content: [22, 22, 22, 22, 22, 22, 22, 22],
        border: [0, 0, 44, 0, 44, 44, 0, 44]
      }
    }))

    await expect(createBridge().getElementCenter(sender, 7, '@e1')).resolves.toEqual({
      cx: 22,
      cy: 22
    })
  })

  it('rejects a collinear layout quad with positive x and y extents', async () => {
    const collinear = [0, 0, 10, 10, 20, 20, 10, 10]
    const sender: CdpCommandSender = vi.fn(async () => ({
      model: { content: collinear, padding: collinear, border: collinear }
    }))

    await expect(createBridge().getElementCenter(sender, 7, '@e1')).rejects.toMatchObject({
      code: 'browser_element_not_interactable'
    })
  })

  it.each([
    ['fieldset-disabled control', { disabledBySelector: true }],
    ['aria-disabled ancestor', { parentAriaDisabled: true }],
    ['inert shadow host', { shadowHostInert: true }],
    ['slotted control inside an inert wrapper', { slottedInertWrapper: true }]
  ])('rejects an effectively disabled %s', async (_label, options) => {
    const bridge = createBridge()

    await expect(
      bridge.assertElementInteractable(createInteractabilitySender(options), 7, '@e1', {
        requireEnabled: true
      })
    ).rejects.toMatchObject({ code: 'browser_element_not_interactable' })
  })

  it('allows a pointer target reached through a regular descendant', async () => {
    const bridge = createBridge()

    await expect(
      bridge.assertElementInteractable(
        createInteractabilitySender({ regularHitDescendant: true }),
        7,
        '@e1',
        { pointerCenter: { cx: 20, cy: 30 } }
      )
    ).resolves.toBeUndefined()
  })

  it('surfaces an interactability evaluation exception as a CDP error', async () => {
    const bridge = createBridge()

    await expect(
      bridge.assertElementInteractable(
        createInteractabilitySender({ evaluationException: true }),
        7,
        '@e1',
        {
          pointerCenter: { cx: 20, cy: 30 }
        }
      )
    ).rejects.toMatchObject({ code: 'browser_cdp_error' })
  })

  it('allows a shadow target reached through a slotted hit descendant', async () => {
    const bridge = createBridge()

    await expect(
      bridge.assertElementInteractable(
        createInteractabilitySender({ slottedHitDescendant: true }),
        7,
        '@e1',
        { pointerCenter: { cx: 20, cy: 30 } }
      )
    ).resolves.toBeUndefined()
  })

  it('resolves duplicate iframe URLs by frame identity', async () => {
    const { bridge, guest, sendCommand } = createIframeHarness()
    const entry = { backendDOMNodeId: 7, sessionId: 'session-2' } as RefEntry

    await expect(bridge.getPageCoordinates(guest, entry, 20, 30)).resolves.toEqual({
      cx: 220,
      cy: 130
    })
    expect(sendCommand).toHaveBeenCalledWith('Page.getFrameTree', undefined, 'session-2')
  })

  it('rejects an iframe pointer target covered in the parent page', async () => {
    const { bridge, guest } = createIframeHarness({ covered: true })
    const entry = { backendDOMNodeId: 7, sessionId: 'session-2' } as RefEntry

    await expect(bridge.getPageCoordinates(guest, entry, 20, 30)).rejects.toMatchObject({
      code: 'browser_element_not_interactable'
    })
  })

  it('classifies a missing iframe owner layout box as not interactable', async () => {
    const { bridge, guest } = createIframeHarness({ ownerMissingLayout: true })
    const entry = { backendDOMNodeId: 7, sessionId: 'session-2' } as RefEntry

    await expect(bridge.getPageCoordinates(guest, entry, 20, 30)).rejects.toMatchObject({
      code: 'browser_element_not_interactable'
    })
  })

  it('resolves a nested OOPIF through each immediate parent session', async () => {
    const { bridge, guest, sendCommand } = createIframeHarness({ nested: true })
    const entry = { backendDOMNodeId: 7, sessionId: 'session-2' } as RefEntry

    await expect(bridge.getPageCoordinates(guest, entry, 20, 30)).resolves.toEqual({
      cx: 270,
      cy: 170
    })
    expect(sendCommand).toHaveBeenCalledWith(
      'DOM.getFrameOwner',
      { frameId: 'frame-2' },
      'session-1'
    )
  })

  it('maps child viewport coordinates through a scaled iframe quad', async () => {
    const { bridge, guest } = createIframeHarness({ transformed: true })
    const entry = { backendDOMNodeId: 7, sessionId: 'session-2' } as RefEntry

    await expect(bridge.getPageCoordinates(guest, entry, 100, 50)).resolves.toEqual({
      cx: 500,
      cy: 300
    })
  })

  it('maps child viewport coordinates through a perspective iframe quad', async () => {
    const { bridge, guest } = createIframeHarness({ perspective: true })
    const entry = { backendDOMNodeId: 7, sessionId: 'session-2' } as RefEntry

    const result = await bridge.getPageCoordinates(guest, entry, 340, 55)

    expect(result.cx).toBeCloseTo(270.461, 3)
    expect(result.cy).toBeCloseTo(133.973, 3)
  })
})
