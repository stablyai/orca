import { beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { EditorState, Selection as ModelSelection, TextSelection } from '@tiptap/pm/state'
import { tableEditingKey } from '@tiptap/pm/tables'
import { EditorView } from '@tiptap/pm/view'
import { Editor } from '@tiptap/core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const protocol = process.env.PR35764_N1_PROTOCOL
const output = resolve(process.env.PR35764_N1_OUTPUT || 'qa-evidence/pr35764-n1/output')
mkdirSync(output, { recursive: true })
const executionCounts = {}
const sha = (value) => createHash('sha256').update(value).digest('hex')
let rowBytes = 0
const caseByteLimit = 64 * 1024 * 1024
let rows = [],
  n = 0,
  overflow = 0,
  phase = 'setup',
  testName = '',
  serial = 0,
  depth = 0
let ids = new WeakMap(),
  nextId = 1
const undos = []
let caseUndos = []
const stateViews = new WeakMap()
const id = (value) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return value
  }
  if (!ids.has(value)) {
    ids.set(value, nextId++)
  }
  return ids.get(value)
}
function range(value) {
  return value
    ? {
        anchorNode: id(value.anchorNode),
        anchorOffset: value.anchorOffset,
        focusNode: id(value.focusNode),
        focusOffset: value.focusOffset
      }
    : null
}
function selection(value) {
  return value
    ? {
        id: id(value),
        type: value.constructor.name,
        anchor: value.anchor,
        head: value.head,
        ranges: value.ranges?.map((r) => [r.$from.pos, r.$to.pos])
      }
    : null
}
function snapshot(view) {
  if (!view) {
    return null
  }
  const observer = view.domObserver,
    input = view.input,
    state = view.state
  return {
    view: id(view),
    destroyed: view.isDestroyed,
    connected: view.dom.isConnected,
    activeElement: id(view.dom.ownerDocument.activeElement),
    focused: view.focused,
    editable: view.editable,
    composing: view.composing,
    state: id(state),
    doc: id(state.doc),
    docChildCount: state.doc.childCount,
    model: selection(state.selection),
    native: range(view.dom.ownerDocument.getSelection()),
    cache: range(observer?.currentSelection),
    suppressing: observer?.suppressingSelectionUpdates,
    flushingSoon: observer?.flushingSoon,
    queueLength: observer?.queue.length,
    lastFocus: input?.lastFocus,
    lastClick: input?.lastClick,
    lastTouch: input?.lastTouch,
    lastKeyCode: input?.lastKeyCode,
    lastKeyCodeTime: input?.lastKeyCodeTime,
    compositionPendingChanges: input?.compositionPendingChanges,
    compositionID: input?.compositionID,
    tableKey: tableEditingKey.getState(state),
    tracker: input?.mouseDown
      ? {
          id: id(input.mouseDown),
          allowDefault: input.mouseDown.allowDefault,
          delayedSelectionSync: input.mouseDown.delayedSelectionSync
        }
      : null
  }
}
function clean(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') {
    return typeof value === 'function' ? { function: id(value) } : value
  }
  if ('anchorNode' in value && 'focusNode' in value) {
    return range(value)
  }
  if (value instanceof Node) {
    return { node: id(value), name: value.nodeName, connected: value.isConnected }
  }
  if (value.$anchor && value.$head && typeof value.eq === 'function') {
    return selection(value)
  }
  if (seen.has(value)) {
    return { reference: id(value) }
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => clean(item, seen))
  }
  const result = {}
  for (const key of Object.keys(value)) {
    result[key] =
      key === 'view' || key === 'editor' || key === 'state' || key === 'doc'
        ? id(value[key])
        : clean(value[key], seen)
  }
  return result
}
function record(event, view, detail = {}) {
  executionCounts[event] = (executionCounts[event] || 0) + 1
  if (rows.length >= 100000) {
    overflow++
    return
  }
  const row = {
    n: ++n,
    monotonicNs: process.hrtime.bigint().toString(),
    clock: Date.now(),
    depth,
    phase,
    event,
    protocol,
    activeElement: id(document.activeElement),
    native: range(document.getSelection())
  }
  try {
    row.snapshot = snapshot(view)
    row.detail = clean(detail)
  } catch (error) {
    row.observationError = String(error)
  }
  const bytes = Buffer.byteLength(JSON.stringify(row)) + 2
  if (bytes > 256 * 1024 || rowBytes + bytes > caseByteLimit - 65536) {
    overflow++
    return
  }
  rowBytes += bytes
  rows.push(row)
}
function wrap(object, key, label, getView = () => null, undoList = undos) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  const original = object[key]
  if (typeof original !== 'function') {
    throw new Error(`Missing observed method ${label}`)
  }
  Object.defineProperty(object, key, {
    ...(descriptor || { configurable: true, writable: true }),
    value: function (...args) {
      let view
      try {
        view = getView(this, args)
      } catch (error) {
        record('instrumentation.getViewError', null, { label, error: String(error) })
      }
      record(`${label}.enter`, view, {
        args: args.map((arg) =>
          arg?.selection && arg?.steps
            ? {
                transaction: id(arg),
                selection: selection(arg.selection),
                selectionSet: arg.selectionSet,
                docChanged: arg.docChanged,
                meta: arg.meta,
                steps: arg.steps.map((step) => step.toJSON())
              }
            : arg instanceof Node
              ? arg
              : typeof arg === 'object'
                ? { id: id(arg) }
                : arg
        ),
        stack: new Error('R4 observed call').stack
      })
      depth++
      try {
        const result = Reflect.apply(original, this, args)
        record(
          `${label}.return`,
          view,
          label === 'state.applyTransaction'
            ? {
                attempted: id(args[0]),
                applied: result.transactions.map((tr) => ({
                  id: id(tr),
                  selection: selection(tr.selection),
                  selectionSet: tr.selectionSet,
                  docChanged: tr.docChanged,
                  meta: tr.meta
                })),
                nextState: id(result.state)
              }
            : {
                result: result?.$anchor
                  ? selection(result)
                  : typeof result === 'object'
                    ? id(result)
                    : result
              }
        )
        return result
      } catch (error) {
        record(`${label}.throw`, view, { error: String(error) })
        throw error
      } finally {
        depth--
      }
    }
  })
  undoList.push(() =>
    descriptor
      ? Object.defineProperty(object, key, descriptor)
      : Reflect.deleteProperty(object, key)
  )
}
function observeEditor(editor) {
  const view = editor.view
  if (!(view instanceof EditorView) || !(view.state instanceof EditorState)) {
    throw new Error('Engine module identity differs; STOP')
  }
  if (
    editor.constructor !== Editor ||
    view.constructor !== EditorView ||
    view.state.constructor !== EditorState ||
    !view.domObserver.forceFlush.toString().includes('engine.observer.forceFlush')
  ) {
    throw new Error('Actual live engine class or logging overlay differs; STOP')
  }
  record('runtime.liveClassIdentity', view, {
    editor: id(editor),
    editorClass: id(Editor),
    viewClass: id(EditorView),
    stateClass: id(EditorState),
    editorClassSha256: sha(Editor.toString()),
    viewClassSha256: sha(EditorView.toString()),
    stateClassSha256: sha(EditorState.toString()),
    liveForceFlushSha256: sha(view.domObserver.forceFlush.toString()),
    liveObserverClassSha256: sha(view.domObserver.constructor.toString()),
    loadedOverlayMarker: 'engine.observer.forceFlush',
    corroborationRequired: 'actual core focus/read/applied transaction events'
  })
  stateViews.set(view.state, view)
  for (const key of [
    'forceFlush',
    'flush',
    'handleDOMChange',
    'setCurSelection',
    'ignoreSelectionChange',
    'stop',
    'start'
  ]) {
    wrap(view.domObserver, key, `observer.${key}`, () => view, caseUndos)
  }
  record('hookInventory', view, {
    hooks: view.state.plugins.map((p) => ({
      key: p.key,
      constructor: Boolean(p.props.createSelectionBetween),
      filter: Boolean(p.spec.filterTransaction),
      append: Boolean(p.spec.appendTransaction),
      stateApply: Boolean(p.spec.state?.apply),
      nodeViews: Object.keys(p.props.nodeViews || {}),
      source: {
        create: p.props.createSelectionBetween?.toString(),
        filter: p.spec.filterTransaction?.toString(),
        append: p.spec.appendTransaction?.toString()
      }
    })),
    directConstructor: view.props.createSelectionBetween?.toString(),
    directPlugins: (view.directPlugins || []).map((p) => p.key)
  })
  for (const plugin of view.state.plugins) {
    for (const [target, keys] of [
      [plugin.props, ['createSelectionBetween']],
      [plugin.spec, ['filterTransaction', 'appendTransaction']]
    ]) {
      for (const key of keys) {
        if (typeof target[key] === 'function') {
          wrap(target, key, `plugin.${plugin.key}.${key}`, () => view, caseUndos)
        }
      }
    }
  }
  return view
}
beforeAll(() => {
  globalThis.__PR35764_N1__ = record
  globalThis.__PR35764_N1_TOOLS__ = {
    record,
    phase: (name) => {
      phase = name
    },
    observeEditor,
    snapshot,
    id,
    rows: () => rows
  }
  for (const key of ['setBaseAndExtent', 'collapse', 'extend', 'addRange', 'removeAllRanges']) {
    wrap(Selection.prototype, key, `native.${key}`)
  }
  for (const key of ['dispatch', 'updateState', 'scrollToSelection']) {
    wrap(EditorView.prototype, key, `view.${key}`, (self, args) => {
      stateViews.set(self.state, self)
      if (key === 'updateState' && args[0]) {
        stateViews.set(args[0], self)
      }
      return self
    })
  }
  wrap(EditorState.prototype, 'applyTransaction', 'state.applyTransaction', (self) =>
    stateViews.get(self)
  )
  wrap(Editor.prototype, 'emit', 'editor.emit', (self, args) => {
    if (args[0] !== 'selectionUpdate') {
      return null
    }
    const view = self.view
    record('selectionUpdate', view, { transaction: id(args[1]?.transaction) })
    return view
  })

  wrap(TextSelection, 'between', 'constructor.TextSelection.between')
  wrap(ModelSelection, 'near', 'constructor.Selection.near')
  for (const type of [
    'focus',
    'focusin',
    'blur',
    'focusout',
    'selectionchange',
    'mousedown',
    'mouseup',
    'mousemove',
    'keydown',
    'beforeinput',
    'copy',
    'compositionstart',
    'compositionend'
  ]) {
    const listener = (event) =>
      record(`event.${type}`, null, {
        target: event.target,
        relatedTarget: event.relatedTarget,
        key: event.key,
        keyCode: event.keyCode,
        buttons: event.buttons,
        inputType: event.inputType
      })
    document.addEventListener(type, listener, true)
    undos.push(() => document.removeEventListener(type, listener, true))
  }
})
beforeEach((context) => {
  rows = []
  rowBytes = 0
  n = 0
  overflow = 0
  ids = new WeakMap()
  nextId = 1
  phase = 'setup'
  testName = context.task.name
  record('case.start', null, { testName, syntheticInputsOnly: true })
})
afterEach(async () => {
  await Promise.resolve()
  record('case.end', null, { testName, overflow })
  const countsByPhase = {}
  for (const row of rows) {
    const counts = (countsByPhase[row.phase] ||= {})
    counts[row.event] = (counts[row.event] || 0) + 1
  }
  const observationErrors = rows.filter(
    (row) => row.observationError || row.event === 'instrumentation.getViewError'
  ).length
  writeFileSync(
    resolve(output, `${protocol}-${String(++serial).padStart(3, '0')}.json`),
    JSON.stringify({ protocol, testName, overflow, observationErrors, countsByPhase, rows })
  )
  for (const undo of caseUndos.toReversed()) {
    undo()
  }
  caseUndos = []
  if (overflow || observationErrors) {
    throw new Error('Diagnostic observation incomplete: overflow/error, no dropped-row pass')
  }
})
afterAll(() => {
  writeFileSync(
    resolve(output, `${protocol}-execution.json`),
    JSON.stringify({
      protocol,
      serial,
      executionCounts,
      required: [
        'runtime.liveClassIdentity',
        'engine.core.focus',
        'engine.readDOMChange',
        'state.applyTransaction.return'
      ],
      transformedIdsAloneAreNotExecutionProof: true
    })
  )
  for (const undo of undos.toReversed()) {
    undo()
  }
  delete globalThis.__PR35764_N1__
  delete globalThis.__PR35764_N1_TOOLS__
  if (
    [
      'runtime.liveClassIdentity',
      'engine.core.focus',
      'engine.readDOMChange',
      'state.applyTransaction.return'
    ].some((name) => !executionCounts[name])
  ) {
    throw new Error('R4 missing actual engine execution corroboration')
  }
})
