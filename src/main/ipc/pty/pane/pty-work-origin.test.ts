import { describe, expect, it } from 'vitest'
import { resolvePtySpawnWorkOrigin } from './pty-work-origin'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from '../../../persistence/runtime-authored-workspace-session-fields'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

const paired = { kind: 'paired-device', deviceId: 'a' } as const

describe('terminal work origin', () => {
  it('retains sleeping pane attribution and honors a new explicit launch including unknown', () => {
    const store = {
      getWorkspaceSession: () => ({ terminalWorkOriginsByPaneKey: { 'tab:leaf': paired } })
    } as never
    expect(resolvePtySpawnWorkOrigin({ tabId: 'tab', leafId: 'leaf' }, store)).toEqual(paired)
    expect(
      resolvePtySpawnWorkOrigin({ tabId: 'tab', leafId: 'leaf', workOrigin: null }, store)
    ).toBeNull()
    expect(resolvePtySpawnWorkOrigin({ tabId: 'new', leafId: 'leaf' }, store)).toEqual({
      kind: 'host'
    })
  })

  it('preserves old writer omissions while allowing trusted retirement', () => {
    const prior = {
      terminalWorkOriginsByPaneKey: { 'tab:leaf': paired }
    } as unknown as WorkspaceSessionState
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields({} as unknown as WorkspaceSessionState, prior)
        .terminalWorkOriginsByPaneKey
    ).toEqual(prior.terminalWorkOriginsByPaneKey)
    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(
        { terminalWorkOriginsByPaneKey: {} } as unknown as WorkspaceSessionState,
        prior
      ).terminalWorkOriginsByPaneKey
    ).toEqual({})
  })
})
