// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  flush,
  mountShell
} from '../../shared/plugins/frames/plugin-frame-shell-mount.test-fixture'
import { editor } from './plugin-frame-templates'

const doc = (version: number, text: string) => ({
  orca: 1,
  kind: 'evt',
  event: 'editor.document',
  payload: { version, readOnly: false, content: { kind: 'text', text } }
})

function mountEditorTemplate() {
  const html = editor({ id: 'notes', name: 'Notes' }).files['editor/index.html']
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<script>/)?.[1] ?? ''
  const shell = mountShell('editor')
  // A block scopes the template's top-level consts to this mount.
  window.eval(`{${html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''}}`)
  const textarea = document.querySelector('textarea')!
  const notice = document.getElementById('notice')!
  const type = (value: string) => {
    textarea.value = value
    textarea.dispatchEvent(new Event('input'))
  }
  return { ...shell, textarea, notice, type }
}

describe('editor template', () => {
  it('keeps typing Orca has not accepted when the file changes outside', async () => {
    const { fromHost, textarea, type } = mountEditorTemplate()
    fromHost(doc(1, 'start'))
    await flush()
    expect(textarea.value).toBe('start')
    type('start typed')
    fromHost(doc(2, 'outside'))
    expect(textarea.value).toBe('start typed')
  })

  it('follows outside changes once its edits are accepted', async () => {
    const { fromHost, textarea, type } = mountEditorTemplate()
    fromHost(doc(1, 'start'))
    await flush()
    type('mine')
    fromHost({ orca: 1, kind: 'res', id: 0, result: null })
    await flush()
    fromHost(doc(2, 'outside'))
    expect(textarea.value).toBe('outside')
  })

  it('shows a refused edit and clears it once an edit is accepted', async () => {
    const { fromHost, notice, posted, type } = mountEditorTemplate()
    fromHost(doc(1, 'start'))
    await flush()
    type('mine')
    fromHost({
      orca: 1,
      kind: 'res',
      id: 0,
      error: { code: 'conflict', message: 'The file changed outside this editor.' }
    })
    await flush()
    expect(notice.textContent).toBe('Not saved: The file changed outside this editor.')
    fromHost(doc(2, 'outside'))
    type('mine again')
    expect(posted().at(-1)).toMatchObject({ params: { baseVersion: 2 } })
    fromHost({ orca: 1, kind: 'res', id: 1, result: null })
    await flush()
    expect(notice.textContent).toBe('')
  })

  it('lets only the newest input settle dirty and the notice', async () => {
    const { fromHost, textarea, notice, type } = mountEditorTemplate()
    fromHost(doc(1, 'start'))
    await flush()
    type('A')
    type('AB')
    type('A')
    fromHost({ orca: 1, kind: 'res', id: 0, result: null })
    await flush()
    // The final `A` is still unanswered, so an outside change must not replace it.
    fromHost(doc(2, 'outside'))
    expect(textarea.value).toBe('A')
    fromHost({ orca: 1, kind: 'res', id: 2, error: { code: 'conflict', message: 'Changed.' } })
    await flush()
    // An older success arriving after a newer refusal keeps the notice.
    fromHost({ orca: 1, kind: 'res', id: 1, result: null })
    await flush()
    expect(notice.textContent).toBe('Not saved: Changed.')
  })
})
