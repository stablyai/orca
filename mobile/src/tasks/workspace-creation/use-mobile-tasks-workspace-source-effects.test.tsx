import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../../mobile-web-shell/bridge-host-test-fakes'
import type { SparsePreset } from '../../../../src/shared/worktree/create-types'
import type { WorkspaceSparseDraft } from '../mobile-tasks-project-workspace-types'
import { item } from '../item-detail/github-task-identity.test-fixture'
import {
  useMobileTasksWorkspaceSourceEffects,
  type WorkspaceSourceEffectsInput
} from './use-mobile-tasks-workspace-source-effects'

const renderers: ReactTestRenderer[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    await act(async () => renderer.unmount())
  }
})

const preset = { id: 'web-only', name: 'Web only', directories: ['packages/web'] }
const createDraft = { item: item('acme') }
const targetRepo = { id: 'repo', path: '/repo', displayName: 'Repo' }

it('keeps the chosen sparse preset and the unsaved preset draft across a reconnect', async () => {
  const client = createFakeRpcClient()
  const seen: { presetId: string | null; draft: WorkspaceSparseDraft | null } = {
    presetId: null,
    draft: null
  }
  const commands = {
    setSupported: (_supported: boolean): void => {},
    choose: (_id: string): void => {},
    editDraft: (_draft: WorkspaceSparseDraft): void => {}
  }
  function Probe(): null {
    const [tasksSupported, setTasksSupported] = useState(true)
    const [presetId, setPresetId] = useState<string | null>(null)
    const [draft, setDraft] = useState<WorkspaceSparseDraft | null>(null)
    const [, setPresets] = useState<SparsePreset[]>([])
    const noop = () => {}
    const model: WorkspaceSourceEffectsInput = {
      client,
      tasksSupported,
      workspaceCreateDraft: createDraft,
      workspaceCreateTargetRepo: targetRepo,
      workspaceSparseReloadKey: 0,
      workspaceBaseBranchQuery: '',
      showWorkspaceBaseBranchPicker: false,
      setWorkspaceBaseBranchError: noop,
      setWorkspaceBaseBranchLoading: noop,
      setWorkspaceBaseBranchResults: noop,
      setWorkspaceSparseDraft: setDraft,
      setWorkspaceSparsePresetId: setPresetId,
      setWorkspaceSparsePresets: setPresets,
      setWorkspaceSparsePresetsError: noop,
      setWorkspaceSparsePresetsLoaded: noop,
      setWorkspaceSparsePresetsLoading: noop
    }
    useMobileTasksWorkspaceSourceEffects(model)
    commands.setSupported = setTasksSupported
    commands.choose = setPresetId
    commands.editDraft = setDraft
    seen.presetId = presetId
    seen.draft = draft
    return null
  }
  await act(async () => {
    renderers.push(create(createElement(Probe)))
  })
  const answerPresets = () =>
    act(async () => client.requests.at(-1)?.resolve(rpcSuccess('presets', { presets: [preset] })))
  await answerPresets()
  await act(async () => commands.choose('web-only'))
  await act(async () => commands.editDraft({ mode: 'new', name: 'Docs', directoriesText: 'docs' }))

  await act(async () => commands.setSupported(false))
  await act(async () => commands.setSupported(true))
  await answerPresets()

  expect(seen).toEqual({
    presetId: 'web-only',
    draft: { mode: 'new', name: 'Docs', directoriesText: 'docs' }
  })
})
