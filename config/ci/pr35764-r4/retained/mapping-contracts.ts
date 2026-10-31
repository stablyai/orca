import { fireEvent } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { expect, it, vi } from 'vitest'
import { createSurface } from './editor-surface'

export function registerMappingContracts() {
  it('bounds repeated input mapping to the owning document at N and 10N', async () => {
    vi.useFakeTimers()
    const samples: number[] = []
    for (const scale of [1, 10]) {
      const paragraphs = 20 * scale
      const surfaces = Array.from({ length: 3 * scale }, () =>
        createSurface('<p>lower caret</p>'.repeat(paragraphs))
      )
      const activeSurface = surfaces.at(-1)
      if (!activeSurface) {
        throw new Error('Expected active editor')
      }
      const active = activeSurface.editor
      const text = active.view.dom.querySelector('p:last-child')?.firstChild
      if (!text) {
        throw new Error('Expected editor text')
      }
      active.view.focus()
      active.commands.setTextSelection(active.view.posAtDOM(text, 2))
      const reads = surfaces.map(() => 0)
      const publications = vi.fn()
      active.on('selectionUpdate', publications)
      const measuredViews = surfaces.map(({ editor }, owner) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Count real sibling reads on the pinned engine's root view description, without replacing its mapping logic.
        const view = editor.view as Editor['view'] & {
          docView: { children: unknown[] }
          domObserver: { flushSoon(): void }
        }
        const children = view.docView.children
        const descriptors: PropertyDescriptorMap = {}
        for (const key of Reflect.ownKeys(children)) {
          const descriptor = Object.getOwnPropertyDescriptor(children, key)
          if (!descriptor) {
            throw new Error('Expected root child property descriptor')
          }
          descriptors[key] = descriptor
        }
        children.forEach((child, index) => {
          Object.defineProperty(children, index, {
            configurable: true,
            get: () => {
              reads[owner]++
              return child
            }
          })
        })
        return {
          restore: () => Object.defineProperties(children, descriptors),
          flushSoon: () => view.domObserver.flushSoon()
        }
      })
      const mappings = surfaces.map(({ editor }) => vi.spyOn(editor.view, 'posAtDOM'))
      const native = document.getSelection()
      if (!native) {
        throw new Error('Expected native selection')
      }
      const restorations = vi.spyOn(native, 'setBaseAndExtent')
      const nativeWrites = [
        vi.spyOn(native, 'collapse'),
        vi.spyOn(native, 'extend'),
        vi.spyOn(native, 'addRange'),
        vi.spyOn(native, 'removeAllRanges')
      ]
      const notifications = vi.fn()
      document.addEventListener('selectionchange', notifications)
      try {
        fireEvent.keyDown(active.view.dom, { key: 'Shift' })
        document.dispatchEvent(new Event('selectionchange'))
        vi.runAllTimers()
        globalThis.__PR35764_N1_TOOLS__?.record('retained.unchangedCounts', active.view, {
          scale,
          paragraphs,
          reads: [...reads],
          publications: publications.mock.calls.length,
          native: [restorations, ...nativeWrites].map((write) => write.mock.calls.length)
        })
        expect(publications).not.toHaveBeenCalled()
        expect(restorations).not.toHaveBeenCalled()
        expect(nativeWrites.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
        expect(reads.slice(0, -1)).toEqual(Array(surfaces.length - 1).fill(0))
        const activeReads = reads.at(-1)
        if (activeReads === undefined) {
          throw new Error('Expected active mapping count')
        }
        if (process.env.PR35764_N1_PROTOCOL === 'routed') {
          expect(activeReads).toBe(0)
        } else {
          expect(activeReads).toBeGreaterThanOrEqual(paragraphs)
        }
        expect(activeReads).toBeLessThanOrEqual(20 * paragraphs)
        samples.push(activeReads)

        for (const [step, boundary] of ['key', 'pending-flush', 'release'].entries()) {
          if (boundary === 'release') {
            vi.spyOn(active.view, 'posAtCoords').mockReturnValue({
              pos: active.state.selection.head,
              inside: -1
            })
            fireEvent.mouseDown(text.parentElement ?? active.view.dom, {
              button: 0,
              buttons: 1,
              shiftKey: true
            })
          }
          native.setBaseAndExtent(text, 7 + step, text, 2 + step)
          restorations.mockClear()
          nativeWrites.forEach((write) => write.mockClear())
          publications.mockClear()
          notifications.mockClear()
          reads.fill(0)
          if (boundary !== 'key') {
            const measuredActive = measuredViews.at(-1)
            if (!measuredActive) {
              throw new Error('Expected active observer')
            }
            measuredActive.flushSoon()
          }
          if (boundary === 'release') {
            fireEvent.mouseUp(document, { button: 0 })
          } else {
            fireEvent.keyDown(active.view.dom, { key: 'Control' })
          }
          globalThis.__PR35764_N1_TOOLS__?.record('retained.changedImmediateCounts', active.view, {
            scale,
            paragraphs,
            boundary,
            reads: [...reads],
            publications: publications.mock.calls.length,
            native: [restorations, ...nativeWrites].map((write) => write.mock.calls.length),
            notifications: notifications.mock.calls.length
          })
          expect(publications).toHaveBeenCalledOnce()
          expect(active.state.selection.anchor - active.state.selection.head).toBe(5)
          expect(notifications).not.toHaveBeenCalled()
          // Deliver completion's notification and settle engine work; it must not restore and notify again.
          document.dispatchEvent(new Event('selectionchange'))
          expect(notifications).toHaveBeenCalledOnce()
          vi.runAllTimers()
          globalThis.__PR35764_N1_TOOLS__?.record('retained.changedSettledCounts', active.view, {
            scale,
            paragraphs,
            boundary,
            reads: [...reads],
            publications: publications.mock.calls.length,
            native: [restorations, ...nativeWrites].map((write) => write.mock.calls.length),
            notifications: notifications.mock.calls.length
          })
          expect(notifications).toHaveBeenCalledTimes(2)
          expect(publications).toHaveBeenCalledOnce()
          const predictedWrites =
            process.env.PR35764_N1_PROTOCOL === 'routed' && boundary !== 'release' ? 0 : 1
          expect(restorations).toHaveBeenCalledTimes(predictedWrites)
          expect(nativeWrites.map((write) => write.mock.calls.length)).toEqual([0, 0, 0, 0])
          expect(
            [restorations, ...nativeWrites].reduce(
              (total, write) => total + write.mock.calls.length,
              0
            )
          ).toBe(predictedWrites)
          expect(reads.slice(0, -1)).toEqual(Array(surfaces.length - 1).fill(0))
          const settledReads = reads.at(-1)
          if (settledReads === undefined) {
            throw new Error('Expected settled owner mapping count')
          }
          expect(settledReads).toBeLessThanOrEqual(30 * paragraphs)
        }
      } finally {
        document.removeEventListener('selectionchange', notifications)
        measuredViews.forEach(({ restore }) => restore())
        surfaces.forEach(({ editor }) => editor.destroy())
        restorations.mockRestore()
        nativeWrites.forEach((write) => write.mockRestore())
      }
      await Promise.resolve()
      const counts = mappings.map((mapping) => mapping.mock.calls.length)
      document.dispatchEvent(new Event('selectionchange'))
      vi.runAllTimers()
      expect(mappings.map((mapping) => mapping.mock.calls.length)).toEqual(counts)
    }
    expect(samples[1]).toBeLessThanOrEqual(12 * samples[0])
  })
}
