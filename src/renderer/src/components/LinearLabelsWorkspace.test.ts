import { describe, expect, it, vi } from 'vitest'
import type { LinearIssueLabel } from '../../../shared/types'
import {
  compactLinearLabelCreateInput,
  compactLinearLabelUpdateInput,
  getLinearLabelsWorkspaceViewState,
  isLinearLabelRetired,
  mutateLinearLabelArchiveState,
  reconcileSelectedLinearLabelTeamId,
  saveLinearLabelForm,
  type LabelFormState,
  type LinearLabelMutationDeps
} from './LinearLabelsWorkspace'

function form(overrides: Partial<LabelFormState> = {}): LabelFormState {
  return {
    name: ' Bug ',
    color: ' #eb5757 ',
    description: ' Defects ',
    teamId: 'team-1',
    parentId: 'none',
    isGroup: false,
    ...overrides
  }
}

function deps(overrides: Partial<LinearLabelMutationDeps> = {}): LinearLabelMutationDeps {
  return {
    createIssueLabel: vi.fn().mockResolvedValue({ ok: true, label: { id: 'label-1' } }),
    updateIssueLabel: vi.fn().mockResolvedValue({ ok: true, label: { id: 'label-1' } }),
    retireIssueLabel: vi.fn().mockResolvedValue({ ok: true, label: { id: 'label-1' } }),
    restoreIssueLabel: vi.fn().mockResolvedValue({ ok: true, label: { id: 'label-1' } }),
    clearMetadataCache: vi.fn(),
    ...overrides
  } as LinearLabelMutationDeps
}

describe('getLinearLabelsWorkspaceViewState', () => {
  it('surfaces loading only when no labels are available yet', () => {
    expect(getLinearLabelsWorkspaceViewState({ loading: true, error: null, labels: [] })).toBe(
      'loading'
    )
    expect(
      getLinearLabelsWorkspaceViewState({
        loading: true,
        error: null,
        labels: [{ id: 'label-1' } as never]
      })
    ).toBe('ready')
  })

  it('prioritizes errors and empty states after loading settles', () => {
    expect(getLinearLabelsWorkspaceViewState({ loading: false, error: 'Nope', labels: [] })).toBe(
      'error'
    )
    expect(getLinearLabelsWorkspaceViewState({ loading: false, error: null, labels: [] })).toBe(
      'empty'
    )
  })
})

describe('reconcileSelectedLinearLabelTeamId', () => {
  it('resets stale team selections to all labels', () => {
    expect(reconcileSelectedLinearLabelTeamId('team-1', [{ id: 'team-1' } as never])).toBe('team-1')
    expect(reconcileSelectedLinearLabelTeamId('team-old', [{ id: 'team-1' } as never])).toBe('all')
    expect(reconcileSelectedLinearLabelTeamId('all', [])).toBe('all')
  })
})

describe('isLinearLabelRetired', () => {
  it('treats archivedAt and retiredAt as retired label states', () => {
    expect(
      isLinearLabelRetired({ archivedAt: '2026-05-30T12:00:00.000Z' } as LinearIssueLabel)
    ).toBe(true)
    expect(
      isLinearLabelRetired({ retiredAt: '2026-05-31T01:00:00.000Z' } as LinearIssueLabel)
    ).toBe(true)
    expect(isLinearLabelRetired({ retired: true } as LinearIssueLabel)).toBe(true)
    expect(isLinearLabelRetired({ archivedAt: null, retiredAt: null } as LinearIssueLabel)).toBe(
      false
    )
  })
})

describe('Linear label form payloads', () => {
  it('builds create and update inputs from form state', () => {
    expect(compactLinearLabelCreateInput(form())).toEqual({
      name: 'Bug',
      color: '#eb5757',
      description: 'Defects',
      teamId: 'team-1',
      parentId: null,
      isGroup: false
    })
    expect(compactLinearLabelUpdateInput(form({ id: 'label-1', description: '' }))).toEqual({
      name: 'Bug',
      color: '#eb5757',
      description: null,
      parentId: null,
      isGroup: false
    })
  })
})

describe('Linear label mutation flows', () => {
  it('creates labels and clears metadata cache after success', async () => {
    const d = deps()

    await expect(saveLinearLabelForm(form(), null, 'workspace-1', d)).resolves.toEqual({
      ok: true,
      message: 'Linear label created.'
    })

    expect(d.createIssueLabel).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ name: 'Bug', teamId: 'team-1' }),
      'workspace-1'
    )
    expect(d.clearMetadataCache).toHaveBeenCalled()
  })

  it('updates labels and returns API errors without clearing metadata cache', async () => {
    const d = deps({ updateIssueLabel: vi.fn().mockResolvedValue({ ok: false, error: 'Nope' }) })

    await expect(
      saveLinearLabelForm(form({ id: 'label-1' }), null, 'workspace-1', d)
    ).resolves.toEqual({
      ok: false,
      error: 'Nope'
    })

    expect(d.updateIssueLabel).toHaveBeenCalledWith(
      null,
      'label-1',
      expect.objectContaining({ name: 'Bug' }),
      'workspace-1'
    )
    expect(d.clearMetadataCache).not.toHaveBeenCalled()
  })

  it('blocks mutation when all workspaces are selected', async () => {
    const d = deps()

    await expect(saveLinearLabelForm(form(), null, 'all', d)).resolves.toEqual({
      ok: false,
      error: 'Select one Linear workspace before editing labels.'
    })

    expect(d.createIssueLabel).not.toHaveBeenCalled()
  })

  it('retires and restores labels through archive helpers', async () => {
    const d = deps()
    const label = { id: 'label-1', name: 'Bug' } as LinearIssueLabel

    await expect(
      mutateLinearLabelArchiveState(label, null, 'workspace-1', 'retire', d)
    ).resolves.toEqual({
      ok: true,
      message: 'Linear label retired.'
    })
    await expect(
      mutateLinearLabelArchiveState(label, null, 'workspace-1', 'restore', d)
    ).resolves.toEqual({
      ok: true,
      message: 'Linear label restored.'
    })

    expect(d.retireIssueLabel).toHaveBeenCalledWith(null, 'label-1', 'workspace-1')
    expect(d.restoreIssueLabel).toHaveBeenCalledWith(null, 'label-1', 'workspace-1')
    expect(d.clearMetadataCache).toHaveBeenCalledTimes(2)
  })
})
