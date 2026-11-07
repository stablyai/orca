import { resolveHiddenProbeCwd } from '../../rate-limits/hidden-probe-cwd'
import { describe, expect, it } from 'vitest'
import { applyCodexConfiguredLaunchDefaults } from '../../codex/structured/launch/codex-configured-launch-defaults'
import type { AgentSessionModelCatalogResult } from '../../../shared/agent-session/agent-session-wire'
import { harness } from './agent-model-catalog-account-list-test-support'

for (const agent of ['claude', 'codex'] as const) {
  describe(`${agent} project defaults on the account listing`, () => {
    it('shows the account’s configured model and effort in every folder, whatever its own settings pick', async () => {
      // Every folder's settings may pick both; the picker still follows the account.
      const h = harness(agent, { workspaceMayOverrideDefaultModel: async () => true })
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
      for (const id of ['a', 'e']) {
        expect(row(await h.read(id, { waitForListing: true }))).toMatchObject({
          isDefault: true,
          defaultEffort: 'high'
        })
        expect(h.service.peek(id)?.configured).toMatchObject({ modelId: h.full[0] })
      }
      expect(h.runs).toEqual([resolveHiddenProbeCwd()])
    })

    it('lists a workspace this host cannot inspect as the account does, never where Orca runs', async () => {
      const h = harness(agent)
      const result = await h.service.read({ agent, workspacePath: null, waitForListing: true })
      expect(result.origin === 'unknown' ? null : result.models).toEqual(
        h.full.map((id) => expect.objectContaining({ id }))
      )
      expect(h.runs).toEqual([resolveHiddenProbeCwd()])
      expect(h.unresolvedRuns).toEqual([])
    })
  })
}
