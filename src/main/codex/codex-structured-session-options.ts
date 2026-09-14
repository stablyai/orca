import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexSession } from './codex-structured-session-state'
import { isCodexTurnOptionKey } from './codex-structured-turn-start'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import { decodeCodexFastMode, reconcileCodexFastModeOption } from './codex-structured-fast-mode'
import { readCodexStructuredSessionOptionCatalog } from './codex-structured-model-catalog'

export function restoredCodexSessionOptions(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  const restored = new Map(
    Object.entries(options ?? {}).filter(([key, value]) => {
      return (
        isCodexTurnOptionKey(key) &&
        (key !== 'fastMode' ||
          typeof decodeStructuredAgentSessionOptionValue('fastMode', value) === 'boolean')
      )
    })
  )
  if (!restored.has('fastMode') && restored.get('serviceTier') === 'default') {
    restored.delete('serviceTier')
    restored.set('fastMode', 'false')
  }
  return restored
}

export type { CodexSessionOptionCatalog } from './codex-structured-model-catalog'

export { readCodexStructuredSessionOptionCatalog } from './codex-structured-model-catalog'

export async function readCodexStructuredSessionOptions(input: {
  connection: Pick<CodexAppServerConnection, 'request'>
  current: { model?: string; effort?: string; fastMode?: boolean }
  reportedServiceTier?: string | null
  reportedServiceTierKnown?: boolean
  timeoutMs?: number
}): Promise<AgentSessionOptionsResult> {
  return (await readCodexStructuredSessionOptionCatalog(input)).result
}

export function readLiveCodexSessionOptions(
  session: CodexSession,
  timeoutMs: number | undefined
): Promise<AgentSessionOptionsResult> {
  const model = session.options.get('model') ?? session.reportedOptions.model
  const effort = session.options.get('effort') ?? session.reportedOptions.effort
  return readCodexStructuredSessionOptionCatalog({
    connection: session.connection,
    current: {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(decodeCodexFastMode(session.options) !== undefined
        ? { fastMode: decodeCodexFastMode(session.options) }
        : {})
    },
    ...(session.reportedOptions.serviceTierKnown
      ? {
          reportedServiceTier: session.reportedOptions.serviceTier ?? null,
          reportedServiceTierKnown: true
        }
      : {}),
    timeoutMs
  }).then((catalog) => {
    reconcileCodexFastModeOption(session, {
      fastModeTierByModel: catalog.fastModeTierByModel,
      currentFastMode: catalog.result.current.fastMode,
      model: catalog.result.current.model,
      modelFastModeSupport: catalog.result.models.find(
        (entry) => entry.id === catalog.result.current.model
      )?.supportsFastMode
    })
    const fastMode = decodeCodexFastMode(session.options)
    return fastMode === undefined
      ? catalog.result
      : { ...catalog.result, current: { ...catalog.result.current, fastMode } }
  })
}

export async function applyCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string,
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  try {
    return await applyValidatedCodexStructuredSessionOption(session, key, value, timeoutMs)
  } catch (error) {
    throw new AgentSessionOptionRejectedError(error)
  }
}

async function applyValidatedCodexStructuredSessionOption(
  session: CodexSession,
  key: string,
  value: string,
  timeoutMs: number | undefined
): Promise<Readonly<Record<string, string>>> {
  // `serviceTier` still restores, so a session persisted before Fast existed migrates,
  // but the turn now derives the tier from `fastMode`. Accepting a direct write would
  // report success for a value the next turn discards.
  if (key === 'serviceTier') {
    throw new Error('codex service tier is derived from Fast mode and cannot be set directly')
  }
  if (key !== 'model' && key !== 'effort' && key !== 'fastMode') {
    session.options.set(key, value)
    return Object.fromEntries(session.options)
  }
  const priorModel = session.options.get('model') ?? session.reportedOptions.model
  const priorEffort = session.options.get('effort') ?? session.reportedOptions.effort
  const catalog = await readCodexStructuredSessionOptionCatalog({
    connection: session.connection,
    current: {
      ...(priorModel ? { model: priorModel } : {}),
      ...(priorEffort ? { effort: priorEffort } : {})
    },
    timeoutMs
  })
  reconcileCodexFastModeOption(session, {
    fastModeTierByModel: catalog.fastModeTierByModel,
    currentFastMode: catalog.result.current.fastMode,
    model: priorModel ?? catalog.result.current.model,
    modelFastModeSupport: catalog.result.models.find(
      (entry) => entry.id === (priorModel ?? catalog.result.current.model)
    )?.supportsFastMode
  })
  if (key === 'model' && !catalog.result.models.some((entry) => entry.id === value)) {
    throw new Error(`codex app-server does not offer model ${value}`)
  }
  const modelId = key === 'model' ? value : catalog.result.current.model
  const model = catalog.result.models.find((entry) => entry.id === modelId)
  if (key === 'fastMode') {
    const requested = decodeStructuredAgentSessionOptionValue('fastMode', value)
    if (typeof requested !== 'boolean') {
      throw new Error('codex fast mode must be encoded as true or false')
    }
    if (
      requested &&
      (model?.supportsFastMode !== true || !catalog.fastModeTierByModel.has(modelId))
    ) {
      throw new Error(`codex app-server model ${modelId} does not support Fast mode`)
    }
    session.options.set('fastMode', value)
    return Object.fromEntries(session.options)
  }
  const requestedEffort = key === 'effort' ? value : priorEffort
  if (
    key === 'effort' &&
    (!model?.efforts.length || !model.efforts.some((effort) => effort.value === requestedEffort))
  ) {
    throw new Error(`codex app-server model ${modelId} does not support ${value}`)
  }
  const effort =
    model?.efforts.length === 0
      ? undefined
      : (model?.efforts.find((entry) => entry.value === requestedEffort)?.value ??
        model?.defaultEffort ??
        model?.efforts[0]?.value)
  session.options.set('model', modelId)
  if (effort) {
    session.options.set('effort', effort)
  } else {
    session.options.delete('effort')
  }
  if (
    key === 'model' &&
    session.options.get('fastMode') === 'true' &&
    model?.supportsFastMode === false
  ) {
    session.options.set('fastMode', 'false')
  }
  return Object.fromEntries(session.options)
}
