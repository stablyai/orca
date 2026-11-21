// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPageSwapSafety } from './page-swap-safety'

afterEach(() => {
  document.body.innerHTML = ''
})

function type(selector: string, value: string): void {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

const never = (): void => {}

describe('a page may reload onto a newer build only at a safe moment', () => {
  it('is safe with fields the page filled itself and none the user typed in', () => {
    const safety = createPageSwapSafety(document)
    document.body.innerHTML =
      '<input type="text" value="My Mac"><textarea>saved prompt</textarea><input readonly>'
    expect(safety.answer(false, never)).toBe(true)
  })

  it('forgets a remounted draft once a new field took it over, or the page moved on', () => {
    const safety = createPageSwapSafety(document)
    document.body.innerHTML = '<textarea></textarea>'
    type('textarea', 'draft')
    document.body.innerHTML = '<textarea id="remounted">draft</textarea>'
    expect(safety.answer(false, null)).toBe(false)
    document.querySelector<HTMLTextAreaElement>('#remounted')!.value = ''
    document.body.insertAdjacentHTML('beforeend', '<textarea>draft</textarea>')
    expect(safety.answer(false, null)).toBe(true)

    type('textarea', 'other draft')
    document.body.innerHTML = ''
    expect(safety.answer(false, null)).toBe(true)
    safety.navigated()
    document.body.innerHTML = '<textarea>other draft</textarea>'
    expect(safety.answer(false, null)).toBe(true)
  })

  it('is safe once a typed draft was cleared, or in a field the user cannot edit', () => {
    const safety = createPageSwapSafety(document)
    document.body.innerHTML = '<textarea></textarea><input disabled>'
    type('textarea', 'sent')
    expect(safety.answer(false, never)).toBe(false)
    type('textarea', '')
    type('input', 'not editable')
    expect(safety.answer(false, never)).toBe(true)
  })

  it('is not safe with a sheet open', () => {
    const safety = createPageSwapSafety(document)
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>'
    expect(safety.answer(false, never)).toBe(false)
  })

  it('is not safe while an upload sent before leaving is unanswered', () => {
    expect(createPageSwapSafety(document).answer(true, never)).toBe(false)
  })
})

describe('a safe answer is taken back as soon as the user acts', () => {
  it('retracts once on the first input after saying safe', () => {
    const safety = createPageSwapSafety(document)
    document.body.innerHTML = '<textarea></textarea>'
    const retract = vi.fn()
    expect(safety.answer(false, retract)).toBe(true)
    type('textarea', 'h')
    type('textarea', 'hi')
    expect(retract).toHaveBeenCalledOnce()
  })

  it('retracts when a sheet opens after saying safe', async () => {
    const safety = createPageSwapSafety(document)
    const retract = vi.fn()
    expect(safety.answer(false, retract)).toBe(true)
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>'
    await vi.waitFor(() => expect(retract).toHaveBeenCalledOnce())
  })

  it('ignores streamed rows and owes nothing when no reload waits on the answer', async () => {
    const safety = createPageSwapSafety(document)
    document.body.innerHTML = '<textarea></textarea><main></main>'
    const retract = vi.fn()
    expect(safety.answer(false, retract)).toBe(true)
    document.querySelector('main')!.append(document.createElement('p'))
    document.querySelector('main')!.setAttribute('aria-busy', 'true')
    await Promise.resolve()
    expect(retract).not.toHaveBeenCalled()
    expect(safety.answer(false, null)).toBe(true)
    type('textarea', 'typed while no reload waits')
    document.body.insertAdjacentHTML('beforeend', '<div aria-modal="true"></div>')
    await Promise.resolve()
    expect(retract).not.toHaveBeenCalled()
  })

  it('owes nothing once the app left', () => {
    const safety = createPageSwapSafety(document)
    document.body.innerHTML = '<textarea></textarea>'
    const retract = vi.fn()
    safety.answer(false, retract)
    safety.disarm()
    type('textarea', 'later')
    expect(retract).not.toHaveBeenCalled()
  })
})
