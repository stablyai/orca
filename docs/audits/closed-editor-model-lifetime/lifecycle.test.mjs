import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import React from 'react'
import { useStore } from 'zustand'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import * as monaco from 'monaco-editor'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeWorktree
} from '../../../src/renderer/src/store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../../src/renderer/src/store/slices/store-session-test-harness'
import { useClosedEditorTabCleanup } from '../../../src/renderer/src/components/editor/useClosedEditorTabCleanup'
import { TerminalLegacyEditorSurface } from '../../../src/renderer/src/components/TerminalLegacyEditorSurface'

const fixture = vi.hoisted(() => ({ store: null }))
const variant = process.env.ORCA_CLOSED_MODEL_VARIANT ?? 'fixed'
const fixed = variant === 'fixed'
const bridge = fixed
  ? (await import('../../../src/renderer/src/lib/editor-model-registry')).editorModelRegistry
  : null
let unregisterRegistry = null
const observations = []
const require = createRequire(resolve('package.json'))
const { loadSources, readText, sha256 } = require(
  resolve('docs/audits/closed-editor-model-lifetime/sources.cjs')
)
const workspace = 'audit-repo::/audit-model-workspace'
const domWindow = globalThis.window

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => fixture.store.getState(),
    subscribe: (...args) => fixture.store.subscribe(...args)
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))
vi.mock('../../../src/renderer/src/components/editor/EditorPanel', async () => {
  const { useClosedEditorTabCleanup } =
    await import('../../../src/renderer/src/components/editor/useClosedEditorTabCleanup')
  return {
    default:
      (process.env.ORCA_CLOSED_MODEL_VARIANT ?? 'fixed') === 'before'
        ? function PanelCleanupPort() {
            const files = useStore(fixture.store, (state) => state.openFiles)
            useClosedEditorTabCleanup(files)
            return React.createElement('div', { 'data-testid': 'cleanup-panel' })
          }
        : function PanelPort() {
            return React.createElement('div', { 'data-testid': 'cleanup-panel' })
          }
  }
})

function FixedShell(props) {
  useClosedEditorTabCleanup()
  return React.createElement(Surface, props)
}
const Shell = fixed ? FixedShell : Surface

function Surface({ visible = true }) {
  const files = useStore(fixture.store, (state) => state.openFiles)
  return React.createElement(TerminalLegacyEditorSurface, {
    controller: {
      activeTabType: visible ? 'editor' : 'terminal',
      renderedActiveWorktreeId: workspace,
      worktreeFiles: files
    }
  })
}

function setup() {
  const api = createStoreSessionMockApi()
  globalThis.window = domWindow
  domWindow.api = api
  unregisterRegistry = bridge?.register(monaco)
  const store = createTestStore()
  fixture.store = store
  store.setState({
    repos: [
      {
        id: 'audit-repo',
        path: '/audit-model-workspace',
        displayName: 'Audit',
        badgeColor: 'gray',
        addedAt: 0,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: {
      'audit-repo': [
        makeWorktree({
          id: workspace,
          repoId: 'audit-repo',
          path: '/audit-model-workspace',
          hostId: 'local'
        })
      ]
    },
    activeWorktreeId: workspace,
    openFiles: [],
    activeFileId: null
  })
  return store
}

function addFile(store, id) {
  const file = {
    id,
    worktreeId: workspace,
    filePath: `/audit-model-workspace/${id}.txt`,
    relativePath: `${id}.txt`,
    mode: 'edit',
    language: 'plaintext',
    isDirty: false,
    runtimeEnvironmentId: null
  }
  const model = monaco.editor.createModel(
    `${id}\n${'x'.repeat(256 * 1024)}`,
    'plaintext',
    monaco.Uri.parse(file.filePath)
  )
  act(() => store.setState({ openFiles: [...store.getState().openFiles, file], activeFileId: id }))
  return model
}

async function mounted(view) {
  await waitFor(() => expect(view.queryByTestId('cleanup-panel')).not.toBeNull())
}

afterEach(() => {
  cleanup()
  unregisterRegistry?.()
  unregisterRegistry = null
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
  vi.unstubAllGlobals()
})

it('measures distinct last-file closes when the final editor removes the panel', async () => {
  const store = setup()
  const view = render(React.createElement(Shell))
  for (let index = 0; index < 8; index += 1) {
    addFile(store, `last-${index}`)
    await mounted(view)
    act(() => store.getState().closeFile(`last-${index}`))
    expect(view.queryByTestId('cleanup-panel')).toBeNull()
    expect(store.getState().openFiles).toHaveLength(0)
    await Promise.resolve()
  }
  const models = monaco.editor.getModels()
  expect(models).toHaveLength(fixed ? 0 : 8)
  observations.push({
    control: 'eight-last-file-closes',
    openFiles: store.getState().openFiles.length,
    retainedModels: models.length,
    logicalCharacters: models.reduce((sum, model) => sum + model.getValueLength(), 0)
  })
})

it('disposes a closed model while another file keeps the panel mounted', async () => {
  const store = setup()
  const closedModel = addFile(store, 'closed-with-sibling')
  const liveModel = addFile(store, 'live-sibling')
  const view = render(React.createElement(Shell))
  await mounted(view)
  act(() => store.getState().closeFile('closed-with-sibling'))
  await Promise.resolve()
  expect(closedModel.isDisposed()).toBe(true)
  expect(liveModel.isDisposed()).toBe(false)
  observations.push({
    control: 'panel-stays-mounted',
    closedDisposed: closedModel.isDisposed(),
    liveDisposed: liveModel.isDisposed()
  })
})

it('measures a close while hidden followed by another editor remount', async () => {
  const store = setup()
  const oldModel = addFile(store, 'hidden-close')
  const view = render(React.createElement(Shell))
  await mounted(view)
  view.rerender(React.createElement(Shell, { visible: false }))
  expect(oldModel.isDisposed()).toBe(false)
  act(() => store.getState().closeFile('hidden-close'))
  await Promise.resolve()
  addFile(store, 'later-editor')
  view.rerender(React.createElement(Shell))
  await mounted(view)
  expect(oldModel.isDisposed()).toBe(fixed)
  expect(monaco.editor.getModels()).toHaveLength(fixed ? 1 : 2)
  observations.push({
    control: 'hidden-close-and-remount',
    retainedClosedModel: !oldModel.isDisposed(),
    openFiles: store.getState().openFiles.length,
    models: monaco.editor.getModels().length
  })
})

it('preserves a still-open model across a normal panel unmount and remount', async () => {
  const store = setup()
  const model = addFile(store, 'normal-switch')
  const view = render(React.createElement(Shell))
  await mounted(view)
  view.rerender(React.createElement(Shell, { visible: false }))
  expect(model.isDisposed()).toBe(false)
  view.rerender(React.createElement(Shell))
  await mounted(view)
  expect(monaco.editor.getModel(model.uri)).toBe(model)
  observations.push({ control: 'normal-switch', originalModelPreserved: true })
})

afterAll(() => {
  const loaded = loadSources()
  const sourceFence = {
    sources: loaded.sources.size,
    graphSha256: sha256(JSON.stringify(loaded.hashes)),
    manifestSha256: sha256(
      readText(resolve('docs/audits/closed-editor-model-lifetime/source-versions.json'))
    ),
    scenarioSha256: sha256(
      readText(resolve('docs/audits/closed-editor-model-lifetime/lifecycle.test.mjs'))
    ),
    loaderSha256: sha256(readText(resolve('docs/audits/closed-editor-model-lifetime/sources.cjs')))
  }
  writeFileSync(
    process.env.ORCA_CLOSED_MODEL_OUTPUT ??
      `docs/audits/closed-editor-model-lifetime/${process.env.ORCA_CLOSED_MODEL_GRAPH ?? 'worktree'}-${variant}-${process.versions.electron ? 'electron' : 'node'}-results.json`,
    `${JSON.stringify({ runtime: process.versions, variant, graph: process.env.ORCA_CLOSED_MODEL_GRAPH ?? 'worktree', sourceFence, observations, scope: 'Actual legacy surface, cleanup hook, disposal, Store close action and installed Monaco models. Shell/Panel bodies are controlled ports; files/models are seeded. Eight distinct fixture paths, 256 KiB characters each. No native editor widget, app window, field file sizes, heap bytes or incident allocation rate.' }, null, 2)}\n`
  )
})
