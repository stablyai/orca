import { describe, expect, it } from 'vitest'
import { RuntimeClientSettingsController } from './runtime-client-settings'
import { createGlobalSettingsFixture } from '../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { SourceControlAiSettings } from '../../shared/rpc-contract/git-params'
import { liftActionPermissionArgs } from '../../shared/source-control-action-permission-lift'
import { getDefaultSourceControlAiSettings } from '../../shared/source-control-ai'

// settings.get is an allowlist: omitted per-action agent recipes look unsaved to paired AI buttons.
function projectionOf(settings: Partial<GlobalSettings>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: get() reads nothing but store.getSettings(); every other RuntimeStore member is unreachable from that path.
  return new RuntimeClientSettingsController({ getSettings: () => settings } as never).get()
}

function hostSettings(sourceControlAi: GlobalSettings['sourceControlAi']): Partial<GlobalSettings> {
  return { ...createGlobalSettingsFixture({ workspaceDir: '/w' }), sourceControlAi }
}

describe('RuntimeClientSettingsController source control launch recipes', () => {
  it('publishes the recipe saved for a launch action', () => {
    const recipe = liftActionPermissionArgs({
      agentId: 'codex' as const,
      agentArgs: '-c model=o3 --fast',
      launchPreferences: {
        agentId: 'claude',
        permissionMode: 'ask',
        modelSelection: {
          base: 'inherit',
          options: { effort: { agentId: 'codex', value: null } }
        }
      }
    })
    const source = { ...getDefaultSourceControlAiSettings(), actions: { fixChecks: recipe } }
    expect(SourceControlAiSettings.parse(source).actions?.fixChecks).toEqual(recipe)
    const projected = projectionOf(hostSettings(source))
    expect(projected.sourceControlAi.actions.fixChecks?.launchPreferences).toEqual(
      recipe.launchPreferences
    )
    expect(projected.sourceControlAi.actions.fixChecks).toMatchObject({
      agentId: 'codex',
      agentArgs: '--fast',
      argumentChoices: { syntaxAgent: 'codex', nodes: [{ at: 0, text: '-c model=o3' }] }
    })
  })

  it('publishes a recipe saved under the legacy launch defaults key', () => {
    const projected = projectionOf(
      hostSettings({
        ...getDefaultSourceControlAiSettings(),
        actions: undefined,
        launchActionDefaults: { resolveConflicts: { agentId: 'claude' } }
      })
    )
    expect(projected.sourceControlAi.actions.resolveConflicts).toMatchObject({ agentId: 'claude' })
  })

  it('publishes launch actions only, not the text generation recipes', () => {
    const projected = projectionOf(hostSettings(getDefaultSourceControlAiSettings()))
    expect(Object.keys(projected.sourceControlAi.actions).sort()).toEqual([
      'fixChecks',
      'fixCommitFailure',
      'fixPushFailure',
      'resolveComments',
      'resolveConflicts'
    ])
  })
})

describe('RuntimeClientSettingsController source control list order', () => {
  it('publishes the group order so paired clients list changes the same way', () => {
    expect(projectionOf({ sourceControlGroupOrder: 'staged-first' }).sourceControlGroupOrder).toBe(
      'staged-first'
    )
    expect(projectionOf({}).sourceControlGroupOrder).toBe('changes-first')
  })

  it('publishes the compare base and whitespace choices desktop diffs use', () => {
    const projected = projectionOf({
      sourceControlCompareAgainstUpstream: true,
      diffShowWhitespace: true
    })
    expect(projected).toMatchObject({
      sourceControlCompareAgainstUpstream: true,
      diffShowWhitespace: true
    })
    expect(projectionOf({})).toMatchObject({
      sourceControlCompareAgainstUpstream: false,
      diffShowWhitespace: false
    })
  })
})
