// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createRichMarkdownEditorDocument,
  startRichMarkdownEditorDocument,
  stopRichMarkdownEditorDocument
} from './create-rich-markdown-editor-document'
import { createRichMarkdownEditorScope } from './document-scope'
import { emitChange, setMarkdown } from './editor-content'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'
import type { RichMarkdownEditorDocument } from './document-host-seams'

/**
 * What a `stop` owes, and what a second call gets.
 *
 * The WebView never stops its document — there the page is the document's whole life — so every
 * case here is about the host that does: a page mounts the editor, unmounts it and mounts it
 * again, and the same modules answer. A listener or an observer the first mount left behind would
 * make the second one report twice and hold the markup the first one read (rulings 20, 21).
 */
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
  const document_ = createRichMarkdownEditorDocument({
    postToHost: (message) => posted.push(message),
    keyboardInsetSource: keyboard.source
  })
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
    // Its own generation and its own surface: the first mount's 9 is not carried over, and the
    // element it read is the one planted for this mount.
    two.handle.setMarkdown('second content', 1)
    editor.dispatchEvent(new Event('input'))
    expect(second).toEqual([{ type: 'change', markdown: 'second content', generation: 1 }])
    expect(first).not.toContainEqual(
      expect.objectContaining({ type: 'change', markdown: 'second content' })
    )
  })

  it('is two editors when two are mounted, each reading its own scope', () => {
    // Not two on one page — the ids collide there, which is the page component's problem — but two
    // documents over the same markup, which is what says the state is per call rather than shared.
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
    // The second document is read-only and says nothing; the first still reports its own
    // generation, which it would not if `editable` lived in a module.
    expect(second).toEqual([])
    expect(first).toEqual([{ type: 'change', markdown: 'shared markup', generation: 3 }])
  })

  it('cancels a change still waiting on a timer, which no listener removal can reach', () => {
    // A listener comes off with the element it was on; a scheduled callback holds the scope and
    // would fire into a document the host has already unmounted. Nothing schedules the handle
    // today, so the pending change is planted here — the seam and the field exist for the day
    // something does, and the cancel has to already be in `stop` when it arrives.
    const posted: MobileRichMarkdownEditorMessage[] = []
    plantMarkup()
    vi.useFakeTimers()
    try {
      const scope = createRichMarkdownEditorScope({
        postToHost: (message) => posted.push(message),
        keyboardInsetSource: () => null
      })
      startRichMarkdownEditorDocument(scope)
      setMarkdown(scope, 'body', 2)
      posted.length = 0

      // The control: while the document is running, the pending change is posted.
      scope.inputTimer = window.setTimeout(() => emitChange(scope), 0)
      vi.runAllTimers()
      expect(posted).toEqual([{ type: 'change', markdown: 'body', generation: 2 }])

      posted.length = 0
      scope.inputTimer = window.setTimeout(() => emitChange(scope), 0)
      stopRichMarkdownEditorDocument(scope)
      expect(scope.inputTimer).toBe(null)
      vi.runAllTimers()
      expect(posted).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a command whose dialog answered after the host moved on', async () => {
    // `promptForUrl` is a modal on the page, so it is a task boundary: between the toolbar press
    // and the URL coming back, the host can replace the content, make the editor read-only or
    // unmount it. Inside the WebView it is `window.prompt`, which answers within a microtask —
    // which is why nothing here can happen on native, and everything here can happen on the page.
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
      const document_ = createRichMarkdownEditorDocument({
        postToHost: (message) => posted.push(message),
        keyboardInsetSource: () => null,
        promptForUrl: () => new Promise((resolve) => answer.push(resolve))
      })
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
      createRichMarkdownEditorDocument({
        postToHost: (message) => posted.push(message),
        keyboardInsetSource: () => {
          throw new Error('no viewport')
        }
      })
    ).toThrow('no viewport')
    // Nothing reported itself ready, and the surface carries no listener of the failed start.
    expect(posted).toEqual([])
    editor.dispatchEvent(new Event('input'))
    expect(posted).toEqual([])
  })
})
