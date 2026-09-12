import type { CodexAppServerConnection } from './codex-app-server-connection'
import {
  codexCatalogAdmitsModel,
  readCodexStructuredSessionOptions,
  reportedCodexThreadOptions,
  restoredCodexSessionOptions,
  type CodexModelCatalog
} from './codex-structured-session-options'
import type { CodexSession } from './codex-structured-session-state'
import type { CodexOpenedThread } from './codex-structured-thread-open'

export type CodexAcquiredSessionOptions = {
  options: Map<string, string>
  reportedOptions: CodexSession['reportedOptions']
  notice?: string
}

const NOTICE_MODEL_ID_LIMIT = 160

function displayedModelId(modelId: string): string {
  const bounded =
    modelId.length > NOTICE_MODEL_ID_LIMIT
      ? `${modelId.slice(0, NOTICE_MODEL_ID_LIMIT - 1)}…`
      : modelId
  return JSON.stringify(bounded)
}

function rejectedModelDescription(input: {
  restored: string | undefined
  reported: string | undefined
}): string {
  if (input.restored && input.reported && input.restored !== input.reported) {
    return `restored model ${displayedModelId(input.restored)} and provider-reported model ${displayedModelId(input.reported)}`
  }
  return `model ${displayedModelId(input.restored ?? input.reported ?? 'unknown')}`
}

function catalogCurrent(input: {
  options: Readonly<Record<string, string>> | undefined
  opened: CodexOpenedThread
}): { model?: string; effort?: string } {
  const restoredModel = input.options?.model || undefined
  const restoredEffort = input.options?.effort || undefined
  const model = restoredModel ?? input.opened.model
  const effort = restoredEffort ?? input.opened.effort
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

async function readCatalog(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  options: Readonly<Record<string, string>> | undefined
  opened: CodexOpenedThread
  timeoutMs: number | undefined
}): Promise<CodexModelCatalog> {
  return readCodexStructuredSessionOptions({
    connection: input.connection,
    current: catalogCurrent(input),
    timeoutMs: input.timeoutMs
  }).catch(() => null)
}

export async function resolveCodexAcquiredSessionOptions(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  options: Readonly<Record<string, string>> | undefined
  opened: CodexOpenedThread
  timeoutMs: number | undefined
}): Promise<CodexAcquiredSessionOptions> {
  const catalog = await readCatalog(input)
  const restoredModel = input.options?.model || undefined
  const reportedModel = input.opened.model
  const restoredRefused = Boolean(restoredModel && !codexCatalogAdmitsModel(catalog, restoredModel))
  const reportedRefused = Boolean(reportedModel && !codexCatalogAdmitsModel(catalog, reportedModel))
  const options = restoredCodexSessionOptions(input.options, catalog)
  const reportedOptions = reportedCodexThreadOptions(input.opened, catalog)

  if (!restoredRefused && !reportedRefused) {
    return { options, reportedOptions }
  }

  const rejected = rejectedModelDescription({
    restored: restoredRefused ? restoredModel : undefined,
    reported: reportedRefused ? reportedModel : undefined
  })
  if (restoredModel && !restoredRefused && reportedRefused) {
    return {
      options,
      reportedOptions,
      notice: `Codex no longer lists ${rejected}. Orca will use the existing restored choice ${displayedModelId(restoredModel)} for this session.`
    }
  }

  const defaults = catalog?.models.filter((model) => model.isDefault) ?? []
  if (defaults.length !== 1) {
    return {
      options: restoredCodexSessionOptions(input.options, null),
      reportedOptions: reportedCodexThreadOptions(input.opened, null),
      notice: `Codex no longer lists ${rejected}, but did not identify a unique provider default. Orca left the model unchanged; choose an available model to continue.`
    }
  }

  const replacement = defaults[0]
  options.set('model', replacement.id)
  options.delete('effort')
  if (
    replacement.defaultEffort &&
    replacement.efforts.some((effort) => effort.value === replacement.defaultEffort)
  ) {
    options.set('effort', replacement.defaultEffort)
  }
  return {
    options,
    reportedOptions,
    notice: `Codex no longer lists ${rejected}. Orca selected the provider-listed default ${displayedModelId(replacement.id)} for this session.`
  }
}
