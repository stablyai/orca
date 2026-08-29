import { describe, expect, it } from 'vitest'
import {
  admitProviderReattachLaunchIdentity,
  resolveSpawnedPaneLaunchToken
} from './launch-authority'

describe('admitProviderReattachLaunchIdentity', () => {
  it('binds provider launch identity to a valid reattach incarnation', () => {
    expect(
      admitProviderReattachLaunchIdentity({
        isReattach: true,
        launchAgent: 'codex',
        incarnationId: 'provider-incarnation'
      })
    ).toEqual({ launchAgent: 'codex', incarnationId: 'provider-incarnation' })
  })

  it.each([
    { label: 'fresh spawn', isReattach: false, launchAgent: 'codex', incarnationId: 'incarnation' },
    {
      label: 'invalid agent',
      isReattach: true,
      launchAgent: 'unknown',
      incarnationId: 'incarnation'
    },
    {
      label: 'missing incarnation',
      isReattach: true,
      launchAgent: 'codex',
      incarnationId: undefined
    },
    {
      label: 'oversized incarnation',
      isReattach: true,
      launchAgent: 'codex',
      incarnationId: 'x'.repeat(129)
    }
  ])('rejects $label metadata', ({ isReattach, launchAgent, incarnationId }) => {
    expect(
      admitProviderReattachLaunchIdentity({ isReattach, launchAgent, incarnationId })
    ).toBeNull()
  })
})

describe('resolveSpawnedPaneLaunchToken', () => {
  it('reports the token this spawn puts into the pane', () => {
    expect(
      resolveSpawnedPaneLaunchToken({
        validatedPaneKey: 'pane-1',
        isReattach: false,
        spawnEnv: { ORCA_AGENT_LAUNCH_TOKEN: 'token-2' }
      })
    ).toEqual({ paneKey: 'pane-1', launchToken: 'token-2' })
  })

  it('reports a respawn into a pane that already has an owner', () => {
    // Why: that is the whole case — the pane whose previous process this spawn replaced is the
    // one whose token-keyed status gates would otherwise keep answering for the old process.
    expect(
      resolveSpawnedPaneLaunchToken({
        validatedPaneKey: 'pane-1',
        isReattach: false,
        spawnEnv: { ORCA_AGENT_LAUNCH_TOKEN: 'token-2', ORCA_PANE_KEY: 'pane-1' }
      })
    ).toEqual({ paneKey: 'pane-1', launchToken: 'token-2' })
  })

  it('reports a tokenless spawn as a token-free pane, not as no spawn', () => {
    expect(
      resolveSpawnedPaneLaunchToken({
        validatedPaneKey: 'pane-1',
        isReattach: false,
        spawnEnv: { ORCA_PANE_KEY: 'pane-1' }
      })
    ).toEqual({ paneKey: 'pane-1', launchToken: undefined })
    expect(
      resolveSpawnedPaneLaunchToken({
        validatedPaneKey: 'pane-1',
        isReattach: false,
        spawnEnv: { ORCA_AGENT_LAUNCH_TOKEN: '   ' }
      })
    ).toEqual({ paneKey: 'pane-1', launchToken: undefined })
  })

  it.each([
    {
      label: 'a reattach, which starts no process',
      validatedPaneKey: 'pane-1',
      isReattach: true,
      spawnEnv: { ORCA_AGENT_LAUNCH_TOKEN: 'token-2' }
    },
    {
      label: 'a spawn whose pane key never validated',
      validatedPaneKey: null,
      isReattach: false,
      spawnEnv: { ORCA_AGENT_LAUNCH_TOKEN: 'token-2' }
    }
  ])('reports nothing for $label', ({ validatedPaneKey, isReattach, spawnEnv }) => {
    expect(resolveSpawnedPaneLaunchToken({ validatedPaneKey, isReattach, spawnEnv })).toBeNull()
  })
})
