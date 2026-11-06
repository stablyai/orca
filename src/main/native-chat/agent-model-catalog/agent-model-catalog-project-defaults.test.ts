import { resolveHiddenProbeCwd } from '../../rate-limits/hidden-probe-cwd'
import { describe, expect, it } from 'vitest'
import { applyCodexConfiguredLaunchDefaults } from '../../codex/structured/launch/codex-configured-launch-defaults'
import { listingFromEntry } from '../../codex/structured/catalog/codex-structured-catalog-entry'
import { composeCodexSessionOptionCatalog } from '../../codex/structured/catalog/codex-structured-model-catalog'
import { getAgentSessionOptionCatalog } from '../../../shared/agent-session/options/agent-session-option-catalog'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session/agent-session-wire'
import {
  applyStructuredAgentSessionModelCatalog,
  commitStructuredAgentSessionOptionValues,
  createStructuredAgentSessionOptionState
} from '../../../shared/agent-session/options/structured-agent-session-options'
import { cloneStructuredAgentSessionOptionRecord } from '../../../shared/agent-session/options/structured-agent-session-option-state'
import { structuredAgentSessionShownSnapshot } from '../../../shared/agent-session/options/structured-agent-session-option-view'
import { harness } from './agent-model-catalog-account-list-test-support'

for (const agent of ['claude', 'codex'] as const) {
  describe(`${agent} project defaults on the account listing`, () => {
    it('withholds the account’s configured model and effort where project settings may pick them, and preserves an unlisted pick', async () => {
      const h = harness(agent, {
        // '/project-a' may pick the model; '/project-effort' only the effort.
        workspaceMayOverrideDefaultModel: async ({ workspacePath }) => ({
          model: workspacePath === '/project-a',
          effort: workspacePath === '/project-a' || workspacePath === '/project-effort'
        })
      })
      const efforts = ['low', 'medium', 'high'].map((value) => ({ value, label: value }))
      const raw = [
        {
          id: h.full[0],
          label: 'Model',
          isDefault: true,
          efforts,
          defaultEffort: 'medium',
          declaredDefaultEffort: 'medium'
        }
      ]
      h.byFolder[resolveHiddenProbeCwd()] = {
        origin: 'probe',
        complete: true,
        configured: { model: h.full[0], effort: 'high' },
        // Codex folds configured defaults into rows before the catalog service sees them.
        models: applyCodexConfiguredLaunchDefaults(raw, { model: h.full[0], effort: 'high' })
      }
      await h.service.read({ agent, waitForListing: true })
      const row = (result: AgentSessionModelCatalogResult) =>
        result.origin === 'unknown' ? null : result.models[0]
      const expectDefaults = (result: AgentSessionModelCatalogResult, model: boolean) => {
        expect(row(result)).toMatchObject({ isDefault: model })
        expect(Object.keys(row(result) ?? {}).filter((key) => key.endsWith('Effort'))).toEqual([])
      }
      const project = await h.read('a', { waitForListing: true })
      expectDefaults(project, false)
      const plain = row(await h.read('b', { waitForListing: true }))
      expect(plain).toMatchObject({ isDefault: true, defaultEffort: 'high' })
      expectDefaults(await h.read('e', { waitForListing: true }), true)
      expect(h.service.peek('a')).toMatchObject({
        configured: null,
        models: [{ isDefault: false }]
      })
      expect(h.service.peek('b')?.configured).not.toBeNull()
      // The chat's own Codex options recompose rows from the peek; nothing there may restore them.
      for (const [id, isDefault] of [
        ['a', false],
        ['e', true],
        ['b', true]
      ] as const) {
        const entry = h.service.peek(id)
        const composed =
          entry && composeCodexSessionOptionCatalog(listingFromEntry(entry), { current: {} })
        const model = composed?.models.find((candidate) => candidate.id === h.full[0])
        expect(model).toMatchObject({ isDefault })
        expect(model?.defaultEffort).toBe(id === 'b' ? 'high' : undefined)
      }
      // A named workspace this host cannot inspect (remote, WSL, ambiguous) may pick its own too.
      for (const legacy of [false, true]) {
        const read = { agent, workspacePath: null, legacy, waitForListing: true }
        expectDefaults(await h.service.read(read), false)
      }
      const seed = getAgentSessionOptionCatalog(agent)
      if (!seed) {
        throw new Error(`missing option catalog for ${agent}`)
      }
      const initial = commitStructuredAgentSessionOptionValues(
        createStructuredAgentSessionOptionState(agent, seed),
        { model: h.full[0] },
        'seeded'
      )
      const apply = (state: typeof initial, catalog: AgentSessionModelCatalogResult) =>
        applyStructuredAgentSessionModelCatalog(state, seed, catalog, {
          newLaunch: true,
          coherentCatalog: true
        })
      const shown = apply(initial, project)
      expect(
        structuredAgentSessionShownSnapshot(shown).find((row) => row.id === 'effort')
      ).not.toMatchObject({ kind: { currentValue: 'high' }, valueSource: 'default' })
      const picked = apply(
        commitStructuredAgentSessionOptionValues(
          { ...shown, record: cloneStructuredAgentSessionOptionRecord(shown.record) },
          { model: 'retired-custom', effort: 'high' }
        ),
        project
      )
      expect(picked.catalog?.models.map((model) => model.id)).toEqual([h.full[0]])
      expect(picked.record.values.model).toEqual({ value: 'retired-custom', source: 'dispatched' })
      expect(picked.record.values.effort).toEqual({ value: 'high', source: 'dispatched' })
      expect(h.runs).toEqual([resolveHiddenProbeCwd()])
    })

    it('lists a workspace this host cannot inspect as the account does, never where Orca runs', async () => {
      const h = harness(agent)
      const result = await h.service.read({ agent, workspacePath: null, waitForListing: true })
      expect(result.origin === 'unknown' ? null : result.models).toEqual(
        h.full.map((id) => expect.objectContaining({ id, isDefault: false }))
      )
      expect(h.runs).toEqual([resolveHiddenProbeCwd()])
      expect(h.unresolvedRuns).toEqual([])
    })
  })
}
