import { toAutomationOwnerPrecondition } from '../../../src/shared/automation-owner-precondition'
import type { MobileAutomationRow } from './automation-reply-schema'
import { automationUpdateWrite } from './automation-operations'
import { automationUpdateParams, type AutomationDraft } from './automation-draft'
import type { AutomationTargets } from './automation-target-inventory'
import { handOffToManagedServer, type AutomationServerHandoff } from './automation-managed-server'
import type { useAutomationCatalog } from './use-automation-catalog'
import type { useAutomationCreateAttempt } from './use-automation-create-attempt'
import type { useAutomationSetupConsent } from './use-automation-setup-consent'

type AutomationSaveContext = {
  /** The row being edited; absent when creating. */
  editing: MobileAutomationRow | undefined
  catalog: Pick<ReturnType<typeof useAutomationCatalog>, 'perform' | 'setRows' | 'capabilities'>
  setupConsent: Pick<ReturnType<typeof useAutomationSetupConsent>, 'prepare'>
  createAttempt: Pick<ReturnType<typeof useAutomationCreateAttempt>, 'submit'>
  handoff?: AutomationServerHandoff
}

/** Update the edited row in place, or create one; a create reconciles through the list. */
export function saveAutomation(
  { editing, catalog, setupConsent, createAttempt, handoff }: AutomationSaveContext,
  input: {
    draft: AutomationDraft
    original: AutomationDraft
    targets: AutomationTargets
    onSaved: (saved: MobileAutomationRow) => void
  }
): void {
  const { draft, original, targets } = input
  void catalog.perform(
    async (client, current) => {
      if (editing) {
        const prepared = await setupConsent.prepare(client, draft, targets, current, original)
        if (!prepared || !current()) {
          return null
        }
        const params = automationUpdateParams(editing.automation.id, prepared, original, targets)
        const result = automationUpdateWrite.interpret(
          await automationUpdateWrite.request(
            client,
            {
              ...params,
              expectedOwner: toAutomationOwnerPrecondition(editing.item.selector)
            },
            { failWhenDisconnected: true }
          )
        )
        return {
          automation: result.automation,
          item: params.destination
            ? { automationId: result.automation.id, selector: params.destination.selector }
            : editing.item
        }
      }
      if (handoff && (await handOffToManagedServer(handoff, client, draft, targets, current))) {
        return null
      }
      await createAttempt.submit(client, draft, targets, catalog.capabilities, current, () =>
        setupConsent.prepare(client, draft, targets, current)
      )
      return null
    },
    (saved) => {
      if (!saved) {
        return
      }
      const id = saved.automation.id
      catalog.setRows((rows) => [...rows.filter((row) => row.automation.id !== id), saved])
      input.onSaved(saved)
    }
  )
}
