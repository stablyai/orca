// Audited Codex provider key IPC handlers. Split from ipc/audited-workflow.ts to
// stay under the max-lines budget without a suppression, matching how the
// execution and plan-review handlers were split.
//
// Electron IPC only — no RPC method is registered for any of these, preserved by
// mobile-rpc-allowlist.test.ts.
//
// Saving the key IS selecting the sole fixed provider: selection is derived from
// the record's presence, so there is one durable write and no second store to
// reconcile. Clearing it returns the task to default-provider behaviour.
//
// DIAGNOSTICS ARE FIXED STRINGS. A raw error object here can embed the key path,
// the safeStorage/OS failure detail, or — on a decrypt path — fragments of the
// value itself, and console output is captured in logs and bug reports. The IPC
// result already carries the truthful outcome, so the error adds nothing the
// caller needs and everything an attacker would want.
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  clearAuditedCodexProviderKey,
  saveAuditedCodexProviderKey
} from '../audited-workflow/audited-codex-provider-key-store'
import { getAuditedCodexProviderStatus } from '../audited-workflow/audited-codex-provider-settings'
import type { AuditedCodexProviderStatus } from '../../shared/audited-codex-provider-types'
import type { AuditedWorkflowSaveCodexProviderKeyParams } from '../../shared/audited-workflow-command-types'

// `{ apiKey }` and NOTHING else. .strict() REJECTS a payload naming a provider,
// settingsId, or baseUrl rather than stripping it, so a renderer attempt to
// choose an endpoint is a hard error, not a silent no-op. Main derives the
// selection from its code-owned registry.
const SaveCodexProviderKeyParams = z.object({ apiKey: z.string().min(1) }).strict()

export function registerAuditedCodexProviderHandlers(): void {
  // Only `{ settingsId, keyConfigured }` ever crosses: never the key, a masked
  // form, a path, or the endpoint. The renderer cannot learn the base URL, which
  // is what keeps the registry a main-side fact.
  ipcMain.handle('auditedWorkflow:getCodexProviderStatus', (): AuditedCodexProviderStatus => {
    return getAuditedCodexProviderStatus()
  })

  ipcMain.handle(
    'auditedWorkflow:saveCodexProviderKey',
    (_event, rawArgs: unknown): AuditedCodexProviderStatus => {
      const args: AuditedWorkflowSaveCodexProviderKeyParams =
        SaveCodexProviderKeyParams.parse(rawArgs)
      try {
        saveAuditedCodexProviderKey(args.apiKey)
      } catch {
        // A storage failure must never reject, and must never surface detail. The
        // status returned below is recomputed from disk either way.
        console.error('[auditedWorkflow] Saving the Codex provider key failed.')
      }
      return getAuditedCodexProviderStatus()
    }
  )

  ipcMain.handle('auditedWorkflow:clearCodexProviderKey', (): AuditedCodexProviderStatus => {
    try {
      clearAuditedCodexProviderKey()
    } catch {
      console.error('[auditedWorkflow] Clearing the Codex provider key failed.')
    }
    return getAuditedCodexProviderStatus()
  })
}
