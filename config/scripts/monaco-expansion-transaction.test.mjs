// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { CodeEditorWidget } from 'monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js'
import { observableValue } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableValue.js'
import { ViewLayout } from 'monaco-editor/esm/vs/editor/common/viewLayout/viewLayout.js'
import { EditorOptions } from 'monaco-editor/esm/vs/editor/common/config/editorOptions.js'
import * as options from '../../src/renderer/src/components/editor/diff-editor-scrollbar-options.ts'
import { autorun } from 'monaco-editor/esm/vs/base/common/observableInternal/reactions/autorun.js'

function fixture(handler) {
  let current = { getLineCount: () => 10 }
  let lineTop = 24
  let scroll = 0
  const writes = []
  const pane = {
    _scrollAnchorHandler: handler,
    getModel: () => current,
    getScrollTop: () => scroll,
    getTopForLineNumber: (line) => (line <= 10 ? lineTop : 0),
    getContentHeight: () => lineTop + 20,
    setScrollTop: (value) => {
      scroll = value
      writes.push(value)
    }
  }
  const run = (update, line = 11) => {
    const method = CodeEditorWidget.prototype._runWithScrollAnchor
    if (method) {
      method.call(pane, line, update)
    } else {
      const top = pane.getTopForLineNumber(line)
      update()
      pane.setScrollTop(scroll + pane.getTopForLineNumber(line) - top)
    }
  }
  return {
    pane,
    run,
    writes,
    grow: () => {
      lineTop += 360
    },
    replace: () => {
      current = null
    }
  }
}

it('hands ownership to the bound host before mutation, after native reactions, with no local compensation', () => {
  const value = observableValue('expansion', 0)
  let geometry = 0
  const reaction = autorun((reader) => {
    geometry = value.read(reader)
  })
  const phases = []
  const host = vi.fn(({ model, lineNumber, update }) => {
    phases.push([model.getLineCount(), lineNumber, geometry])
    update()
    update()
    phases.push(['complete', geometry])
    return true
  })
  const f = fixture(host)
  const update = vi.fn((tx) => value.set(360, tx))
  f.run(update)
  expect(host).toHaveBeenCalledTimes(1)
  expect(update).toHaveBeenCalledTimes(1)
  expect(phases).toEqual([
    [10, 11, 0],
    ['complete', 360]
  ])
  expect(f.writes).toEqual([])
  reaction.dispose()
})

it('keeps standalone EOF compensation and invokes each repeated expansion exactly once', () => {
  const f = fixture(undefined)
  const update = vi.fn(f.grow)
  f.run(update)
  f.run(update)
  expect(update).toHaveBeenCalledTimes(2)
  expect(f.writes).toEqual([360, 720])
})

it.each(['before', 'after', 'update', 'replacement'])(
  'consumes the original change once and never compensates a combined %s failure',
  (phase) => {
    const failure = new Error(phase)
    const update = vi.fn(() => {
      if (phase === 'update') {
        throw failure
      }
    })
    const f = fixture(({ update: apply }) => {
      if (phase === 'before') {
        throw failure
      }
      if (phase === 'replacement') {
        f.replace()
        return
      }
      apply()
      if (phase === 'after') {
        throw failure
      }
    })
    if (phase === 'replacement') {
      f.run(update)
    } else {
      expect(() => f.run(update)).toThrow(failure)
    }
    expect(update).toHaveBeenCalledTimes(1)
    expect(f.writes).toEqual([])
  }
)

it('keeps native pane scroll ranges equal with one horizontal scrollbar, without covering the last line', () => {
  const scrollbar = options.combinedDiffSectionScrollbarOptions
  const padding = options.combinedDiffSectionPadding?.bottom ?? 0
  const values = new Map([
    [EditorOptions.scrollbar.id, scrollbar],
    [EditorOptions.scrollBeyondLastLine.id, false],
    [EditorOptions.padding.id, { bottom: padding }]
  ])
  const layout = {
    _configuration: { options: { get: (key) => values.get(key) } },
    _linesLayout: { getLinesTotalHeight: () => 924 + padding },
    _getHorizontalScrollbarHeight: ViewLayout.prototype._getHorizontalScrollbarHeight
  }
  const content = (width) => ViewLayout.prototype._getContentHeight.call(layout, width, 785, 1305)
  expect(content(5)).toBe(content(1305))
  expect(padding).toBeGreaterThanOrEqual(scrollbar.horizontalScrollbarSize)
  expect(content(5) - 785).toBe(159)
})

it('disconnects only the outgoing bound handler and leaves the replacement ownership intact', () => {
  const f = fixture(undefined)
  const first = vi.fn(({ update }) => {
    update()
    return true
  })
  const second = vi.fn(({ update }) => {
    update()
    return true
  })
  const register = CodeEditorWidget.prototype.setScrollAnchorHandler
  const outgoing = register?.call(f.pane, first)
  const incoming = register?.call(f.pane, second)
  outgoing?.dispose()
  f.run(f.grow)
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledTimes(1)
  expect(f.writes).toEqual([])
  incoming?.dispose()
  f.run(f.grow)
  expect(f.writes).toEqual([360])
})

it('uses standalone compensation when an attached handler declines ownership', () => {
  const f = fixture(() => false)
  const update = vi.fn(f.grow)
  f.run(update)
  expect(update).toHaveBeenCalledTimes(1)
  expect(f.writes).toEqual([360])
})
