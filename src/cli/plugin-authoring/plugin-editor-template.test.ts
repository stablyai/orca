// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountShell } from '../../shared/plugins/frames/plugin-frame-shell-mount.test-fixture'
import { editor } from './plugin-frame-templates'

const hello = { orca: 1, kind: 'evt', event: 'hello', payload: { locale: 'en' } }
const doc = (version: number, text: string) => ({
  orca: 1,
  kind: 'evt',
  event: 'editor.document',
  payload: { version, readOnly: false, content: { kind: 'text', text } }
})
const settle = () => vi.advanceTimersByTimeAsync(0)

async function mountEditorTemplate() {
  const html = editor({ id: 'notes', name: 'Notes' }).files['editor/index.html']
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<script>/)?.[1] ?? ''
  const shell = mountShell('editor')
  // A block scopes the template's top-level consts to this mount.
  window.eval(`{${html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''}}`)
  shell.fromHost(hello)
  shell.fromHost(doc(1, 'start'))
  await settle()
  const textarea = document.querySelector('textarea')!
  const notice = document.getElementById('notice')!
  const type = (value: string) => {
    textarea.value = value
    textarea.dispatchEvent(new Event('input'))
  }
  const edits = () => shell.posted().filter((message) => message.method === 'editor.applyEdit')
  return { ...shell, textarea, notice, type, edits }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('editor template', () => {
  it('keeps typing Orca has not accepted when the file changes outside', async () => {
    const { fromHost, textarea, type } = await mountEditorTemplate()
    expect(textarea.value).toBe('start')
    type('start typed')
    fromHost(doc(2, 'outside'))
    expect(textarea.value).toBe('start typed')
  })

  it('follows outside changes once its edits are accepted', async () => {
    const { fromHost, textarea, type, edits } = await mountEditorTemplate()
    type('mine')
    await vi.advanceTimersByTimeAsync(250)
    expect(edits()).toHaveLength(1)
    fromHost({ orca: 1, kind: 'res', id: 0, result: null })
    await settle()
    fromHost(doc(2, 'outside'))
    expect(textarea.value).toBe('outside')
  })

  it('shows a refused edit once typing pauses, and clears it once an edit is accepted', async () => {
    const { fromHost, notice, type, edits } = await mountEditorTemplate()
    type('mine')
    await vi.advanceTimersByTimeAsync(250)
    fromHost({ orca: 1, kind: 'res', id: 0, error: { code: 'too_large', message: 'Too big.' } })
    await vi.advanceTimersByTimeAsync(250)
    // The pause check resends the kept draft and shows its refusal.
    fromHost({ orca: 1, kind: 'res', id: 1, error: { code: 'too_large', message: 'Too big.' } })
    await settle()
    expect(notice.textContent).toBe('Not saved: Too big.')
    type('min')
    await vi.advanceTimersByTimeAsync(500)
    expect(edits().at(-1)).toMatchObject({ params: { content: { text: 'min' } } })
    fromHost({ orca: 1, kind: 'res', id: 2, result: null })
    await settle()
    expect(notice.textContent).toBe('')
  })
})
