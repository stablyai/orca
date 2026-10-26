// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_PASSWORDS_GUEST_CHANNELS,
  BROWSER_PASSWORDS_TO_GUEST_CHANNELS
} from '../shared/browser-passwords-types'
import type { BrowserPasswordFillRequest } from '../shared/browser-passwords-types'
import { installBrowserPasswordDetector } from './browser-password-detector'
import {
  PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS,
  PRELOAD_BROWSER_PASSWORDS_TO_GUEST_CHANNELS
} from './browser-password-guest-channels'

const CHANNEL = BROWSER_PASSWORDS_GUEST_CHANNELS

type Sent = { channel: string; payload: unknown }

let sent: Sent[]
let listeners: Map<string, (payload: unknown) => void>
let rects: WeakMap<Element, DOMRect>
let teardown: (() => void)[]

function install(): void {
  installBrowserPasswordDetector({
    send: (channel, payload) => sent.push({ channel, payload }),
    on: (channel, listener) => listeners.set(channel, listener)
  })
}

function enable(): void {
  listeners.get(BROWSER_PASSWORDS_TO_GUEST_CHANNELS.enable)?.(undefined)
}

function fill(request: BrowserPasswordFillRequest): unknown {
  listeners.get(BROWSER_PASSWORDS_TO_GUEST_CHANNELS.fill)?.(request)
  return sentOn(CHANNEL.fillResult).at(-1)
}

function sentOn(channel: string): unknown[] {
  return sent.filter((message) => message.channel === channel).map((message) => message.payload)
}

function readString(payload: unknown, key: string): string {
  const record: Record<string, unknown> =
    typeof payload === 'object' && payload !== null ? { ...payload } : {}
  const value = record[key]
  if (typeof value !== 'string') {
    throw new Error(`payload has no string ${key}`)
  }
  return value
}

function trusted<E extends Event>(event: E): E {
  Object.defineProperty(event, 'isTrusted', { configurable: true, value: true })
  return event
}

function el<T extends Element = HTMLInputElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) {
    throw new Error(`missing ${selector}`)
  }
  return found
}

/** Gives every input its own row, so the hit test can tell them apart. */
function layout(): void {
  document.querySelectorAll('input, button').forEach((element, index) => {
    if (!rects.has(element)) {
      rects.set(element, new DOMRect(10, 10 + index * 40, 200, 30))
    }
  })
}

function load(body: string): void {
  document.body.innerHTML = body
  layout()
}

function typeInto(input: HTMLInputElement, value: string, isTrusted = true): void {
  input.value = value
  const event = new Event('input', { bubbles: true, composed: true })
  input.dispatchEvent(isTrusted ? trusted(event) : event)
}

function focusIn(input: HTMLInputElement, isTrusted = true): void {
  const event = new FocusEvent('focusin', { bubbles: true, composed: true })
  input.dispatchEvent(isTrusted ? trusted(event) : event)
}

const LOGIN_FORM = `
  <form id="login" action="/session">
    <input id="email" name="email" type="email">
    <input id="pw" name="password" type="password">
    <button id="go" type="submit">Sign in</button>
  </form>`

/** Stands in for layout: `hidden` or display:none on the element or an ancestor collapses its box. */
function isCollapsed(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (
      node.hasAttribute('hidden') ||
      (node instanceof HTMLElement && node.style.display === 'none')
    ) {
      return true
    }
  }
  return false
}

/** Why: the detector has no uninstall, and the document outlives each test. */
function recordDetectorAttachments(): void {
  for (const target of [document, window]) {
    const add = target.addEventListener.bind(target)
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      teardown.push(() => target.removeEventListener(type, listener, options))
      add(type, listener, options)
    })
  }
  const observe = MutationObserver.prototype.observe
  vi.spyOn(MutationObserver.prototype, 'observe').mockImplementation(function (
    this: MutationObserver,
    target,
    options
  ) {
    teardown.push(() => this.disconnect())
    observe.call(this, target, options)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  sent = []
  listeners = new Map()
  rects = new WeakMap()
  teardown = []
  recordDetectorAttachments()
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return isCollapsed(this)
      ? new DOMRect(0, 0, 0, 0)
      : (rects.get(this) ?? new DOMRect(0, 0, 100, 20))
  })
  document.elementFromPoint = (x: number, y: number) => {
    const hits = Array.from(document.querySelectorAll('input')).filter((input) => {
      const box = input.getBoundingClientRect()
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    })
    return hits.at(-1) ?? document.body
  }
  // Why a form submit is stopped: happy-dom would otherwise try to navigate the test window.
  document.addEventListener('submit', (event) => event.preventDefault())
  vi.mocked(document.addEventListener).mockClear()
})

afterEach(() => {
  for (const undo of teardown) {
    undo()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('browser password detector', () => {
  it('sends and listens on exactly the channels main uses', () => {
    expect(PRELOAD_BROWSER_PASSWORDS_GUEST_CHANNELS).toEqual(BROWSER_PASSWORDS_GUEST_CHANNELS)
    expect(PRELOAD_BROWSER_PASSWORDS_TO_GUEST_CHANNELS).toEqual(BROWSER_PASSWORDS_TO_GUEST_CHANNELS)
  })

  it('installs only its main listeners until main enables the document', async () => {
    load(LOGIN_FORM)
    const addEventListener = vi.mocked(document.addEventListener)
    const observe = vi.mocked(MutationObserver.prototype.observe)

    install()
    typeInto(el('#pw'), 'secret')
    await vi.advanceTimersByTimeAsync(1000)

    expect([...listeners.keys()].sort()).toEqual(
      Object.values(BROWSER_PASSWORDS_TO_GUEST_CHANNELS).sort()
    )
    expect(addEventListener).not.toHaveBeenCalled()
    expect(observe).not.toHaveBeenCalled()
    expect(sent).toEqual([])

    enable()
    expect(observe).toHaveBeenCalled()
  })

  it('stops observing and reporting once main turns it off', async () => {
    load(LOGIN_FORM)
    install()
    enable()
    await vi.advanceTimersByTimeAsync(600)
    sent = []

    listeners.get(BROWSER_PASSWORDS_TO_GUEST_CHANNELS.disable)?.(undefined)
    typeInto(el('#pw'), 'secret')
    el('#pw').dispatchEvent(trusted(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    el('#login').remove()
    await vi.advanceTimersByTimeAsync(1000)

    expect(sent.filter(({ channel }) => channel !== CHANNEL.fieldBlurred)).toEqual([])
  })

  it('reports the page forms once after enable and again only when they change', async () => {
    load(LOGIN_FORM)
    install()
    enable()
    await vi.advanceTimersByTimeAsync(600)

    expect(sentOn(CHANNEL.pageForms)).toEqual([
      {
        forms: [
          {
            formSignature: expect.any(String),
            kind: 'login',
            usernameFieldName: 'email',
            passwordFieldName: 'password',
            action: new URL('/session', window.location.href).toString()
          }
        ]
      }
    ])

    document.body.insertAdjacentHTML('beforeend', '<p>unrelated</p>')
    await vi.advanceTimersByTimeAsync(600)
    expect(sentOn(CHANNEL.pageForms)).toHaveLength(1)

    document.body.insertAdjacentHTML(
      'beforeend',
      '<form id="signup"><input name="new_email"><input type="password" autocomplete="new-password"></form>'
    )
    layout()
    await vi.advanceTimersByTimeAsync(600)
    expect(sentOn(CHANNEL.pageForms).at(-1)).toEqual({
      forms: [
        expect.objectContaining({ kind: 'login' }),
        expect.objectContaining({ kind: 'signup' })
      ]
    })
  })

  it('sends nothing on a page without credential fields', async () => {
    load('<input name="q" type="search"><p>hello</p>')
    install()
    enable()
    await vi.advanceTimersByTimeAsync(2000)
    expect(sent).toEqual([])
  })

  it('reports trusted typing after the debounce, with only typed values', async () => {
    load(LOGIN_FORM)
    el('#email').value = 'prefilled@example.com'
    install()
    enable()

    typeInto(el('#pw'), 'se')
    typeInto(el('#pw'), 'secret')
    await vi.advanceTimersByTimeAsync(299)
    expect(sentOn(CHANNEL.typed)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(sentOn(CHANNEL.typed)).toEqual([
      expect.objectContaining({
        kind: 'login',
        username: null,
        password: 'secret',
        newPassword: null
      })
    ])
  })

  it('ignores typing, submits, clicks and focus the page scripted itself', async () => {
    load(LOGIN_FORM)
    install()
    enable()

    typeInto(el('#email'), 'alice@example.com', false)
    typeInto(el('#pw'), 'secret', false)
    focusIn(el('#pw'), false)
    el('#go').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    el<HTMLFormElement>('#login').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    )
    await vi.advanceTimersByTimeAsync(1000)

    expect(sentOn(CHANNEL.typed)).toEqual([])
    expect(sentOn(CHANNEL.submitted)).toEqual([])
    expect(sentOn(CHANNEL.fieldFocused)).toEqual([])
  })

  it('sends one submitted per gesture, then formGone once the form is removed', async () => {
    load(LOGIN_FORM)
    install()
    enable()
    typeInto(el('#email'), 'alice@example.com')
    typeInto(el('#pw'), 'secret')

    el('#go').dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, composed: true })))
    el<HTMLFormElement>('#login').dispatchEvent(
      trusted(new Event('submit', { bubbles: true, cancelable: true }))
    )

    expect(sentOn(CHANNEL.submitted)).toEqual([
      expect.objectContaining({
        kind: 'login',
        username: 'alice@example.com',
        password: 'secret',
        source: 'button'
      })
    ])
    const formSignature = readString(sentOn(CHANNEL.submitted)[0], 'formSignature')

    el('#login').remove()
    await vi.advanceTimersByTimeAsync(600)
    document.body.insertAdjacentHTML('beforeend', '<p>welcome</p>')
    await vi.advanceTimersByTimeAsync(600)

    expect(sentOn(CHANNEL.formGone)).toEqual([{ formSignature }])
  })

  it('reports Enter in a credential field and formGone when its fields are hidden', async () => {
    load(LOGIN_FORM)
    install()
    enable()
    typeInto(el('#pw'), 'secret')

    el('#pw').dispatchEvent(trusted(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    expect(sentOn(CHANNEL.submitted)).toEqual([
      expect.objectContaining({ password: 'secret', source: 'enter' })
    ])
    expect(sentOn(CHANNEL.typed)).toHaveLength(1)

    el('#login').setAttribute('hidden', '')
    await vi.advanceTimersByTimeAsync(600)
    expect(sentOn(CHANNEL.formGone)).toHaveLength(1)
  })

  it('does not treat fields disabled during the login request as a form that went away', async () => {
    load(LOGIN_FORM)
    install()
    enable()
    typeInto(el('#pw'), 'secret')
    el('#pw').dispatchEvent(trusted(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

    el('#email').disabled = true
    el('#pw').disabled = true
    await vi.advanceTimersByTimeAsync(600)
    expect(sentOn(CHANNEL.formGone)).toEqual([])
  })

  it('ignores a click on a button that does not submit credentials', () => {
    load(
      `${LOGIN_FORM.replace('</form>', '<button id="forgot" type="button">Forgot password?</button></form>')}`
    )
    install()
    enable()
    typeInto(el('#pw'), 'secret')

    el('#forgot').dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, composed: true })))

    expect(sentOn(CHANNEL.submitted)).toEqual([])
  })

  it('reports a focused credential field with its box, and hides on blur and scroll', async () => {
    load(LOGIN_FORM)
    install()
    enable()
    window.innerWidth = 1280

    focusIn(el('#pw'))
    const fieldToken = readString(sentOn(CHANNEL.fieldFocused)[0], 'fieldToken')
    expect(sentOn(CHANNEL.fieldFocused)[0]).toEqual({
      fieldToken: expect.any(String),
      formSignature: expect.any(String),
      role: 'password',
      rect: { x: 10, y: 50, width: 200, height: 30 },
      viewportWidth: 1280
    })

    el('#pw').dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }))
    expect(sentOn(CHANNEL.fieldBlurred)).toEqual([{ fieldToken }])

    focusIn(el('#email'))
    expect(sentOn(CHANNEL.fieldFocused).at(-1)).toMatchObject({ role: 'username' })
    await vi.advanceTimersByTimeAsync(300)
    window.dispatchEvent(new Event('scroll'))
    expect(sentOn(CHANNEL.fieldBlurred)).toHaveLength(2)
    window.dispatchEvent(new Event('scroll'))
    expect(sentOn(CHANNEL.fieldBlurred)).toHaveLength(2)
  })

  it('keeps a show-password toggle classified as a password', async () => {
    load(LOGIN_FORM)
    install()
    enable()
    el('#pw').setAttribute('type', 'text')
    await vi.advanceTimersByTimeAsync(600)

    focusIn(el('#pw'))

    expect(sentOn(CHANNEL.fieldFocused)).toEqual([expect.objectContaining({ role: 'password' })])
  })

  it('reports a field inside an open shadow root', async () => {
    load('<div id="host"></div>')
    const shadow = el<HTMLDivElement>('#host').attachShadow({ mode: 'open' })
    shadow.innerHTML = '<form><input name="user"><input id="pw" type="password"></form>'
    const pw = shadow.querySelector('input[type="password"]')
    if (!(pw instanceof HTMLInputElement)) {
      throw new Error('missing shadow password')
    }
    rects.set(pw, new DOMRect(10, 10, 200, 30))
    install()
    enable()

    focusIn(pw)

    expect(sentOn(CHANNEL.fieldFocused)).toEqual([expect.objectContaining({ role: 'password' })])
  })

  describe('fill', () => {
    function focusedToken(input: HTMLInputElement): string {
      focusIn(input)
      return readString(sentOn(CHANNEL.fieldFocused).at(-1), 'fieldToken')
    }

    it('writes username and password so a controlled input sees them, and submits them', () => {
      load(LOGIN_FORM)
      install()
      enable()
      const seen: string[] = []
      document.addEventListener('input', (event) => {
        if (event.target instanceof HTMLInputElement) {
          seen.push(`${event.target.name}=${event.target.value}`)
        }
      })
      const changes = vi.fn()
      el('#pw').addEventListener('change', changes)

      const result = fill({
        requestId: 'r1',
        fieldToken: focusedToken(el('#pw')),
        username: 'alice@example.com',
        password: 'secret'
      })

      expect(result).toEqual({ requestId: 'r1', ok: true })
      expect(el('#email').value).toBe('alice@example.com')
      expect(el('#pw').value).toBe('secret')
      expect(seen).toEqual(['email=alice@example.com', 'password=secret'])
      expect(changes).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(el('#pw'))

      el('#go').dispatchEvent(trusted(new MouseEvent('click', { bubbles: true, composed: true })))
      expect(sentOn(CHANNEL.submitted)).toEqual([
        expect.objectContaining({ username: 'alice@example.com', password: 'secret' })
      ])
    })

    it('fills from the username field and replaces a placeholder value', () => {
      load(LOGIN_FORM)
      el('#email').value = 'Email'
      install()
      enable()

      fill({
        requestId: 'r',
        fieldToken: focusedToken(el('#email')),
        username: 'bob',
        password: 'pw'
      })

      expect(el('#email').value).toBe('bob')
      expect(el('#pw').value).toBe('pw')
    })

    it('fills the picked account over a different username already in the field', () => {
      load(LOGIN_FORM)
      el('#email').value = 'carol@example.com'
      install()
      enable()

      fill({ requestId: 'r', fieldToken: focusedToken(el('#pw')), username: 'bob', password: 'pw' })

      expect(el('#email').value).toBe('bob')
      expect(el('#pw').value).toBe('pw')
    })

    it('refuses rather than pair a password with a different username it cannot change', () => {
      load(LOGIN_FORM)
      el('#email').value = 'carol@example.com'
      el('#email').readOnly = true
      install()
      enable()

      const result = fill({
        requestId: 'r',
        fieldToken: focusedToken(el('#pw')),
        username: 'bob',
        password: 'pw'
      })

      expect(result).toEqual({ requestId: 'r', ok: false, reason: 'username-mismatch' })
      expect(el('#pw').value).toBe('')
    })

    it('rechecks the password box after page code reacts to the username', () => {
      load(LOGIN_FORM)
      install()
      enable()
      const fieldToken = focusedToken(el('#pw'))
      el('#email').addEventListener('input', () => el('#pw').setAttribute('hidden', ''))

      const result = fill({ requestId: 'r', fieldToken, username: 'bob', password: 'pw' })

      expect(result).toEqual({ requestId: 'r', ok: false, reason: 'not-visible' })
      expect(el('#pw').value).toBe('')
    })

    it.each([
      ['hidden', (pw: HTMLInputElement) => pw.setAttribute('hidden', ''), 'not-visible'],
      [
        'too small',
        (pw: HTMLInputElement) => rects.set(pw, new DOMRect(10, 50, 4, 4)),
        'not-visible'
      ],
      ['transparent', () => (el<HTMLFormElement>('#login').style.opacity = '0.05'), 'not-visible'],
      [
        'visibility hidden',
        (pw: HTMLInputElement) => (pw.style.visibility = 'hidden'),
        'not-visible'
      ],
      [
        'covered by an overlay',
        () => (document.elementFromPoint = () => document.body),
        'not-visible'
      ],
      ['readonly', (pw: HTMLInputElement) => (pw.readOnly = true), 'not-editable'],
      ['removed', (pw: HTMLInputElement) => pw.remove(), 'field-gone']
    ])('refuses a password field that is %s', (_name, mutate, reason) => {
      load(LOGIN_FORM)
      install()
      enable()
      const fieldToken = focusedToken(el('#pw'))
      const pw = el('#pw')
      mutate(pw)

      const result = fill({ requestId: 'r', fieldToken, username: 'bob', password: 'pw' })

      expect(result).toEqual({ requestId: 'r', ok: false, reason })
      expect(pw.value).toBe('')
      expect(el('#email').value).toBe('')
    })

    it('refuses a token it never issued', () => {
      load(LOGIN_FORM)
      install()
      enable()

      expect(
        fill({ requestId: 'r', fieldToken: 'forged', username: null, password: 'pw' })
      ).toEqual({
        requestId: 'r',
        ok: false,
        reason: 'field-gone'
      })
    })

    it('fills only the username on a username-first step', () => {
      load(
        '<form><input id="user" name="identifier" autocomplete="username"><button>Next</button></form>'
      )
      install()
      enable()

      const result = fill({
        requestId: 'r',
        fieldToken: focusedToken(el('#user')),
        username: 'dave',
        password: 'pw'
      })

      expect(result).toEqual({ requestId: 'r', ok: true })
      expect(el('#user').value).toBe('dave')
    })

    it('does not report its own focus moves as user focus', () => {
      load(LOGIN_FORM)
      install()
      enable()
      const fieldToken = focusedToken(el('#email'))
      const focusedBefore = sentOn(CHANNEL.fieldFocused).length

      fill({ requestId: 'r', fieldToken, username: 'bob', password: 'pw' })

      expect(sentOn(CHANNEL.fieldFocused)).toHaveLength(focusedBefore)
      expect(sentOn(CHANNEL.fieldBlurred)).toEqual([{ fieldToken }])
    })
  })
})
