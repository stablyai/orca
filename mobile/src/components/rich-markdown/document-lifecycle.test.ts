// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorDocument } from './document-host-seams'

// Prove stop/restart releases listeners/observers and per-mount state; WebView owns whole page lifetime, but page remount must not double-report or retain old markup (rulings 20/21).
const started: RichMarkdownEditorDocument[] = []

function plantMarkup() {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  return document.getElementById('editor')!
}

function viewportDouble() {
  const observers: (() => void)[] = []
  return {
    observers,
    source: () => ({
      measure: () => 120,
      observe: (onChange: () => void) => {
        observers.push(onChange)
        return () => {
          observers.splice(observers.indexOf(onChange), 1)
        }
      }
    })
  }
}

function mount(posted: MobileRichMarkdownEditorMessage[], keyboard = viewportDouble()) {
  const document_ = createRichMarkdownEditorDocument(
    quietRichMarkdownEditorHost({
      postToHost: (message) => posted.push(message),
      keyboardInsetSource: keyboard.source
    })
  )
  started.push(document_)
  return { handle: document_.send, stop: () => document_.stop(), keyboard }
}

afterEach(() => {
  while (started.length > 0) {
    started.pop()!.stop()
  }
  document.body.innerHTML = ''
})

describe('an editor document that is stopped', () => {
  it('takes its own listeners off the surface', () => {
    const posted: MobileRichMarkdownEditorMessage[] = []
    const editor = plantMarkup()
    const mounted = mount(posted)
    mounted.handle.setMarkdown('body', 1)
    posted.length = 0

    mounted.stop()
    editor.dispatchEvent(new Event('input'))
    editor.dispatchEvent(new Event('change'))
    editor.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    expect(posted).toEqual([])
  })

  it('stops observing the viewport, so no inset of its own reaches the next mount', () => {
    const posted: MobileRichMarkdownEditorMessage[] = []
    plantMarkup()
    const mounted = mount(posted)
    expect(mounted.keyboard.observers).toHaveLength(1)
    mounted.stop()
    expect(mounted.keyboard.observers).toHaveLength(0)
  })

  it('leaves a second mount a document of its own, not the first one continued', () => {
    const first: MobileRichMarkdownEditorMessage[] = []
    plantMarkup()
    const one = mount(first)
    one.handle.setMarkdown('first content', 9)
    one.stop()

    const second: MobileRichMarkdownEditorMessage[] = []
    const editor = plantMarkup()
    const two = mount(second)
    expect(second).toEqual([{ type: 'keyboardInset', bottom: 120 }, { type: 'ready' }])
    second.length = 0
    // Fresh mount owns generation/surface; prior mount’s 9 must not carry over.
    two.handle.setMarkdown('second content', 1)
    editor.dispatchEvent(new Event('input'))
    expect(second).toEqual([{ type: 'change', markdown: 'second content', generation: 1 }])
    expect(first).not.toContainEqual(
      expect.objectContaining({ type: 'change', markdown: 'second content' })
    )
  })

  it('is two editors when two are mounted, each reading its own scope', () => {
    // Two document calls over same markup isolate state; overlapping #editor hosts are tested separately.
    const first: MobileRichMarkdownEditorMessage[] = []
    const second: MobileRichMarkdownEditorMessage[] = []
    const editor = plantMarkup()
    const one = mount(first)
    const two = mount(second)
    first.length = 0
    second.length = 0
    one.handle.setMarkdown('shared markup', 3)
    two.handle.setEditable(false)
    editor.dispatchEvent(new Event('input'))
    // Read-only second document stays silent while first retains its own generation, ruling out module-global editable state.
    expect(second).toEqual([])
    expect(first).toEqual([{ type: 'change', markdown: 'shared markup', generation: 3 }])
  })

  it('drops a command whose dialog answered after the host moved on', async () => {
    // Page URL modal creates task boundary: host can replace content, set read-only or unmount while waiting; native prompt answers within microtask.
    const commands: string[] = []
    const answer: ((url: string) => void)[] = []
    plantMarkup()
    Object.defineProperty(document, 'execCommand', {
      value: (command: string) => {
        commands.push(command)
        return true
      },
      configurable: true
    })
    try {
      const posted: MobileRichMarkdownEditorMessage[] = []
      const document_ = createRichMarkdownEditorDocument(
        quietRichMarkdownEditorHost({
          postToHost: (message) => posted.push(message),
          keyboardInsetSource: () => null,
          promptForUrl: () => new Promise((resolve) => answer.push(resolve))
        })
      )
      started.push(document_)
      document_.send.setMarkdown('before', 1)

      // The control: nothing moved, so the answer is applied and the change is reported.
      const applied = document_.send.runCommand('link')
      answer.pop()!('https://example.com/a')
      await applied
      expect(commands).toEqual(['createLink'])
      expect(posted.at(-1)).toEqual({ type: 'change', markdown: 'before', generation: 1 })

      // Replaced content: the answer belongs to markdown nobody is looking at any more.
      posted.length = 0
      const stale = document_.send.runCommand('link')
      document_.send.setMarkdown('after', 2)
      answer.pop()!('https://example.com/b')
      await stale
      expect(commands).toEqual(['createLink'])
      expect(posted).toEqual([])

      // Read-only, and then stopped: neither takes the command either.
      const whileReadOnly = document_.send.runCommand('image')
      document_.send.setEditable(false)
      answer.pop()!('https://example.com/c')
      await whileReadOnly
      document_.send.setEditable(true)
      const whileStopped = document_.send.runCommand('image')
      document_.stop()
      answer.pop()!('https://example.com/d')
      await whileStopped
      expect(commands).toEqual(['createLink'])
    } finally {
      Reflect.deleteProperty(document, 'execCommand')
    }
  })

  it('unwinds a start that throws rather than leaving the listeners it already installed', () => {
    const posted: MobileRichMarkdownEditorMessage[] = []
    const editor = plantMarkup()
    expect(() =>
      createRichMarkdownEditorDocument(
        quietRichMarkdownEditorHost({
          postToHost: (message) => posted.push(message),
          keyboardInsetSource: () => {
            throw new Error('no viewport')
          }
        })
      )
    ).toThrow('no viewport')
    // Nothing reported itself ready, and the surface carries no listener of the failed start.
    expect(posted).toEqual([])
    editor.dispatchEvent(new Event('input'))
    expect(posted).toEqual([])
  })
})
