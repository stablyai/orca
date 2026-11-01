import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generalE2eShards } from './ci-e2e-job-selection.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'
import { PR_FEATURE_AREA_E2E_SOURCE_ROUTES } from './pr-feature-area-e2e-source-routes.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

function productSources(directory) {
  return readdirSync(join(projectDir, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).slice(projectDir.length + 1))
    .map((file) => file.split('\\').join('/'))
    .filter((file) => !/\.test\.tsx?$/.test(file))
}

describe('feature area PR E2E routing', () => {
  it.each([
    [
      'src/renderer/src/components/automations/AutomationDeleteDialogs.tsx',
      'automation-runs-dashboard'
    ],
    ['src/renderer/src/components/feature-wall/AgentCapabilityStatusBadges.tsx', 'feature-wall'],
    ['src/renderer/src/components/sparse/SparseCheckoutPresetDraftForm.tsx', 'sparse-preset-proof'],
    ['src/renderer/src/components/onboarding/AgentStep.tsx', 'onboarding'],
    ['src/renderer/src/components/diff-comments/DiffCommentCard.tsx', 'diff-note-edit'],
    [
      'src/renderer/src/components/floating-terminal/FloatingTerminalEmptyState.tsx',
      'floating-terminal-switch-reveal'
    ],
    ['src/main/speech/model-catalog.ts', 'voice-microphone-selection'],
    ['src/renderer/src/components/right-sidebar/AiVaultPanel.tsx', 'ai-vault-panel-search'],
    ['src/main/ai-vault-search/session-search-child-service.ts', 'ai-vault-panel-search'],
    ['src/main/linear/client.ts', 'linear-private-images'],
    ['src/renderer/src/components/task-page/jira/Content.tsx', 'jira-panel-layout'],
    ['src/renderer/src/components/task-page/Content.tsx', 'tasks-page'],
    ['src/main/project-groups/folder-workspace-path-status.ts', 'project-group-manual-sort'],
    ['src/renderer/src/components/stats/UsageOverviewPane.tsx', 'usage-overview'],
    ['src/renderer/src/components/pet/PetOverlay.tsx', 'pet-status-segment-layout'],
    ['src/renderer/src/components/setup-guide/SetupGuideModal.tsx', 'setup-guide-sidebar'],
    [
      'src/renderer/src/components/new-workspace/ComposerBaseRefPicker.tsx',
      'new-workspace-create-more'
    ]
  ])('routes %s to %s', (file, spec) => {
    expect(selectPrE2eSpecs([file])).toContain(`tests/e2e/${spec}.spec.ts`)
  })

  it('routes only to specs that exist', () => {
    for (const spec of PR_FEATURE_AREA_E2E_SOURCE_ROUTES.flatMap((route) => route.specs)) {
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
    }
  })

  it('routes every product source in each owned feature directory', () => {
    for (const directory of [
      'src/renderer/src/components/automations',
      'src/renderer/src/components/feature-wall',
      'src/renderer/src/components/onboarding',
      'src/renderer/src/components/diff-comments',
      'src/renderer/src/components/task-page',
      'src/main/ai-vault',
      'src/main/linear',
      'src/main/jira'
    ]) {
      const files = productSources(directory)
      expect(files.length, directory).toBeGreaterThan(0)
      for (const file of files) {
        expect(
          PR_FEATURE_AREA_E2E_SOURCE_ROUTES.some((route) => route.matches(file)),
          file
        ).toBe(true)
      }
    }
  })

  it('keeps any single feature directory in one changed-spec shard', () => {
    for (const route of PR_FEATURE_AREA_E2E_SOURCE_ROUTES) {
      expect(generalE2eShards(JSON.stringify(route.specs)), route.id).toEqual(['1/1'])
    }
  })

  it('leaves unit tests and neighbouring sources alone', () => {
    for (const file of [
      'src/renderer/src/components/automations/AutomationDestinationField.test.tsx',
      'src/renderer/src/components/right-sidebar/FileExplorer.tsx',
      'src/main/linear-unrelated.ts',
      'src/renderer/src/components/settings/GeneralPane.tsx'
    ]) {
      expect(
        PR_FEATURE_AREA_E2E_SOURCE_ROUTES.filter((route) => route.matches(file)),
        file
      ).toEqual([])
    }
  })
})
