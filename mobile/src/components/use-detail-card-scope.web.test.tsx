// @vitest-environment happy-dom
import { Fragment, act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  DetailCardHostProvider,
  DetailCardLayer,
  DetailCardFocusBoundary
} from './detail-card-host.web'
import { useDetailCardScope } from './use-detail-card-scope.web'

it('keeps outside actions and finite focus order while releasing a retained visual', () => {
  const root = document.createElement('div')
  document.body.append(root)
  const node = (id: string) => {
    const value = document.getElementById(id)
    if (!(value instanceof HTMLElement)) {
      throw new Error(id)
    }
    return value
  }
  const renderer = createRoot(root)
  const dismiss = vi.fn()
  const action = vi.fn()
  function Scope({
    active,
    obscured = false,
    source = 'title'
  }: {
    active: boolean
    obscured?: boolean
    source?: 'title' | 'tab1' | 'tab2'
  }) {
    const contentRef = useRef<HTMLDivElement>(null)
    const boundaryRefs = useRef<unknown[]>([])
    const titleRef = useRef<HTMLButtonElement>(null)
    const tab1Ref = useRef<HTMLButtonElement>(null)
    const tab2Ref = useRef<HTMLButtonElement>(null)
    const openerRef = source === 'title' ? titleRef : source === 'tab1' ? tab1Ref : tab2Ref
    const backRef = useRef<HTMLButtonElement>(null)
    useDetailCardScope({ active, obscured, openerRef, backRef, contentRef, boundaryRefs, dismiss })
    return (
      <>
        <input id="terminal" />
        <button ref={backRef} id="back">
          Back
        </button>
        <DetailCardFocusBoundary
          refs={boundaryRefs}
          index={0}
          active={active && source === 'title'}
        />
        <button ref={titleRef} id="opener">
          Title
        </button>
        <DetailCardFocusBoundary
          refs={boundaryRefs}
          index={1}
          active={active && source === 'title'}
        />
        <button id="files" onClick={action}>
          Files
        </button>
        {(['tab1', 'tab2'] as const).map((id) => (
          <Fragment key={id}>
            <DetailCardFocusBoundary
              refs={boundaryRefs}
              index={0}
              active={active && source === id}
            />
            <button id={id} ref={id === 'tab1' ? tab1Ref : tab2Ref}>
              {id}
            </button>
            <DetailCardFocusBoundary
              refs={boundaryRefs}
              index={1}
              active={active && source === id}
            />
          </Fragment>
        ))}
        <button id="more">More</button>
        <DetailCardLayer>
          <DetailCardFocusBoundary refs={boundaryRefs} index={2} active={active} />
          <div ref={contentRef} id="card" tabIndex={-1} aria-hidden={!active}>
            <div id="scroll" tabIndex={active ? 0 : -1}>
              Details
            </div>
          </div>
          <DetailCardFocusBoundary refs={boundaryRefs} index={3} active={active} />
        </DetailCardLayer>
      </>
    )
  }
  const render = (active: boolean, obscured = false, source: 'title' | 'tab1' | 'tab2' = 'title') =>
    act(() =>
      renderer.render(
        <DetailCardHostProvider>
          <Scope active={active} obscured={obscured} source={source} />
        </DetailCardHostProvider>
      )
    )
  const focusBoundary = (id: string, backwards: boolean) => {
    const boundary = backwards ? node(id).previousElementSibling : node(id).nextElementSibling
    if (!(boundary instanceof HTMLElement)) {
      throw new Error(`Missing focus boundary beside ${id}`)
    }
    boundary.focus()
  }

  const key = (type: string, name: string, shiftKey = false) =>
    document.activeElement?.dispatchEvent(
      new KeyboardEvent(type, { key: name, shiftKey, bubbles: true, cancelable: true })
    )
  const terminalKeys = vi.fn()
  window.addEventListener('keydown', terminalKeys)
  try {
    render(false)
    expect(document.activeElement).toBe(document.body)
    const opener = node('opener')
    const host = node('card').parentElement
    expect(host?.parentElement).toBe(document.body)
    node('terminal').focus()
    render(true)
    expect(node('terminal').inert).toBe(false)
    node('back').click()
    expect(dismiss).not.toHaveBeenCalled()
    key('keydown', 'Escape')
    key('keyup', 'Escape')
    expect(terminalKeys).not.toHaveBeenCalled()
    render(false)
    expect(node('card').inert).toBe(true)
    expect(opener.previousElementSibling).toBe(node('back'))
    expect(opener.nextElementSibling).toBe(node('files'))
    expect(node('card').nextElementSibling).toBeNull()
    expect(document.activeElement).toBe(node('terminal'))
    render(true)
    key('keydown', 'Tab')
    focusBoundary('opener', false)
    expect(document.activeElement).toBe(node('scroll'))
    key('keydown', 'Tab', true)
    focusBoundary('card', true)
    expect(document.activeElement).toBe(opener)
    key('keydown', 'Tab', true)
    focusBoundary('opener', true)
    expect(document.activeElement).toBe(node('back'))
    render(false)
    render(true)
    key('keydown', 'Tab')
    focusBoundary('card', false)
    expect(document.activeElement).toBe(node('files'))
    expect(dismiss).toHaveBeenCalledTimes(3)
    render(false)
    render(true)
    node('files').click()
    expect(action).toHaveBeenCalledTimes(1)
    expect(dismiss).toHaveBeenCalledTimes(4)
    node('files').focus()
    render(false)
    expect(document.activeElement).toBe(node('files'))
    render(true)
    node('files').focus()
    expect(dismiss).toHaveBeenCalledTimes(5)
    render(false)
    expect(document.activeElement).toBe(node('files'))
    render(true)
    render(false, true)
    expect(node('card').inert).toBe(true)
    expect(node('opener')).toBe(opener)
    render(true)
    render(true, false, 'tab1')
    key('keydown', 'Tab')
    focusBoundary('tab1', false)
    expect(document.activeElement).toBe(node('scroll'))
    render(true, false, 'tab2')
    key('keydown', 'Tab', true)
    focusBoundary('card', true)
    expect(document.activeElement).toBe(node('tab2'))
    key('keydown', 'Tab')
    focusBoundary('card', false)
    expect(document.activeElement).toBe(node('more'))
    render(false, false, 'tab2')
    render(true, false, 'tab2')
    const outsideActions = action.mock.calls.length
    node('files').click()
    expect(action).toHaveBeenCalledTimes(outsideActions + 1)
    act(() => renderer.unmount())
    expect(host?.isConnected).toBe(false)
  } finally {
    window.removeEventListener('keydown', terminalKeys)
    root.remove()
  }
})

it('yields to a higher sheet while an earlier card contact is still in flight', () => {
  const root = document.createElement('div')
  document.body.append(root)
  const mount = document.createElement('div')
  root.append(mount)
  const renderer = createRoot(mount)
  const dismiss = vi.fn()
  const action = vi.fn()
  const openerRef = { current: document.createElement('button') }
  const contentRef = { current: document.createElement('div') }
  const backRef = { current: document.createElement('button') }
  const boundaryRefs = { current: [] }
  const sheet = document.createElement('button')
  contentRef.current.tabIndex = -1
  sheet.addEventListener('click', action)
  root.append(openerRef.current, backRef.current, contentRef.current, sheet)
  function Scope({ obscured }: { obscured: boolean }) {
    useDetailCardScope({
      active: !obscured,
      obscured,
      openerRef,
      contentRef,
      backRef,
      boundaryRefs,
      dismiss
    })
    return null
  }
  const contact = (target: HTMLElement, type: string, pointerId: number) =>
    target.dispatchEvent(
      new PointerEvent(type, { pointerId, pointerType: 'touch', bubbles: true, cancelable: true })
    )
  try {
    openerRef.current.focus()
    act(() => renderer.render(<Scope obscured={false} />))
    expect(contact(contentRef.current, 'pointerdown', 1)).toBe(true)
    act(() => renderer.render(<Scope obscured />))
    sheet.focus()
    expect(contentRef.current.inert).toBe(true)
    expect(contact(sheet, 'pointerdown', 2)).toBe(true)
    expect(contact(contentRef.current, 'pointerup', 1)).toBe(true)
    expect(contact(sheet, 'pointerup', 2)).toBe(true)
    sheet.click()
    expect(action).toHaveBeenCalledTimes(1)
    expect(dismiss).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(sheet)
  } finally {
    act(() => renderer.unmount())
    root.remove()
  }
})
