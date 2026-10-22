// What a running ACP agent reports about its own choices — config options (model, reasoning
// effort), the older model list, and its `/` commands — as Orca's option and command surfaces.
// Kept as the agent last reported it; nothing here is guessed or listed by Orca itself.

import { abortSignalReason } from '../../shared/abort-signal-reason'

import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice,
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import type { AcpStructuredConnection } from './acp-structured-connection'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import {
  unpickedSessionConfiguredChoice,
  withLiveCatalogListing,
  type AgentModelCatalogConfiguredChoice,
  type AgentModelCatalogLiveListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import {
  SessionConfigSelectGroupSchema,
  SessionConfigSelectOptionSchema,
  type AvailableCommand,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionModelState
} from './generated/acp-protocol.generated'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

/** How an Orca option key reaches the agent: a config option it declared, or the model method. */
export type AcpOptionWrite =
  | { method: 'config'; configId: string; value: string }
  | { method: 'model'; modelId: string }

function selectChoices(option: SelectOption): SessionConfigSelectOption[] {
  const choices: SessionConfigSelectOption[] = []
  for (const entry of option.options) {
    const group = SessionConfigSelectGroupSchema.safeParse(entry)
    if (group.success) {
      choices.push(...group.data.options)
      continue
    }
    const choice = SessionConfigSelectOptionSchema.safeParse(entry)
    if (choice.success) {
      choices.push(choice.data)
    }
  }
  return choices
}

function isSelect(option: SessionConfigOption): option is SelectOption {
  return option.type === 'select'
}

export class AcpStructuredOptions {
  constructor(
    private readonly dialect: Pick<AcpDialect, 'modelEfforts' | 'withheldCommands'> = {}
  ) {}

  private configOptions: SessionConfigOption[] = []
  private models: SessionModelState | null = null
  private commands: AgentSessionSlashCommand[] | undefined
  // A loaded session keeps the model it ran; only a new one resolves the agent's own config.
  private resolvesConfig = false
  readonly picked = new Set<string>()
  private initialChoice: Readonly<Record<string, string>> = {}
  currentProof = new Set<string>()
  writeRevision = 0

  /** The session state a new, load or resume response reported. */
  adoptSession(
    response: {
      configOptions?: SessionConfigOption[] | null
      models?: SessionModelState | null
    },
    origin: 'new' | 'loaded' = 'loaded'
  ): void {
    this.configOptions = response.configOptions ?? []
    this.models = response.models ?? null
    this.resolvesConfig = origin === 'new'
    this.initialChoice = this.reported()
    this.currentProof = new Set(Object.keys(this.initialChoice))
  }

  /** The native selection before any message changed this child. */
  messageDefault(): Readonly<Record<string, string>> {
    return this.initialChoice
  }

  /** Orca sent `key` to the session, or the chat's saved options hold a value for it. */
  notePick(key: string): void {
    this.picked.add(key)
  }

  adoptConfigOptions(configOptions: SessionConfigOption[] | null | undefined): void {
    if (configOptions) {
      this.configOptions = configOptions
    }
  }

  adoptModel(modelId: string): void {
    if (this.models) {
      this.models = { ...this.models, currentModelId: modelId }
    }
  }

  adoptCommands(commands: readonly AvailableCommand[]): void {
    const withheld = this.dialect.withheldCommands ?? []
    this.commands = commands
      .filter((command) => !withheld.includes(command.name))
      .map((command) => ({
        name: command.name,
        kind: 'command',
        ...(command.description ? { description: command.description } : {}),
        ...(command.input?.hint ? { argumentHint: command.input.hint } : {})
      }))
  }

  readCommands(): AgentSessionSlashCommand[] | undefined {
    return this.commands
  }

  /** Where a pick of `key` goes; null when the agent offers nothing for it. */
  write(key: string, value: string): AcpOptionWrite | null {
    if (key === 'model') {
      const option = this.select('model')
      if (option) {
        return { method: 'config', configId: option.id, value }
      }
      return this.models ? { method: 'model', modelId: value } : null
    }
    if (key === 'effort') {
      const option = this.select('thought_level')
      return option ? { method: 'config', configId: option.id, value } : null
    }
    return null
  }

  /**
   * The agent's models and what this session runs. A model's effort menu and default are catalog
   * facts: the dialect's per-model menu when the agent advertises one, else the session's effort
   * option for the model it runs now only. The session's current values are never a default.
   */
  read(): Pick<AgentSessionOptionsResult, 'models' | 'current'> {
    const modelOption = this.select('model')
    const effortOption = this.select('thought_level')
    const sessionEfforts: AgentSessionOptionChoice[] = effortOption
      ? selectChoices(effortOption).map((choice) => ({
          value: choice.value,
          label: choice.name,
          ...(choice.description ? { description: choice.description } : {})
        }))
      : []
    const currentModel = (modelOption?.currentValue ?? this.models?.currentModelId) || undefined
    const listed: { id: string; label: string; description?: string }[] = modelOption
      ? selectChoices(modelOption).map((choice) => ({
          id: choice.value,
          label: choice.name,
          ...(choice.description ? { description: choice.description } : {})
        }))
      : (this.models?.availableModels.map((model) => ({
          id: model.modelId,
          label: model.name,
          ...(model.description ? { description: model.description } : {})
        })) ?? [])
    const models: AgentSessionModelOption[] = listed.map((model) => {
      const info = this.models?.availableModels.find((entry) => entry.modelId === model.id)
      const advertised = info ? this.dialect.modelEfforts?.(info) : undefined
      const sessionMenu = { efforts: model.id === currentModel ? sessionEfforts : [] }
      return {
        ...model,
        isDefault: false,
        // An empty advertised menu is no menu: the running model keeps the one its session offers.
        ...(advertised && advertised.efforts.length > 0 ? advertised : sessionMenu)
      }
    })
    const confirmed = [...(currentModel ? ['model'] : []), ...(effortOption ? ['effort'] : [])]
    return {
      models,
      current: {
        ...(currentModel ? { model: currentModel } : {}),
        ...(effortOption ? { effort: effortOption.currentValue } : {}),
        confirmed
      }
    }
  }

  /** With no model sent since a new session began, what it runs is the agent's own config
   *  resolution: that scope's configured default. Null when that names no listed model; undefined
   *  when this session can't say. */
  configuredDefault(): AgentModelCatalogConfiguredChoice | null | undefined {
    const { models, current } = this.read()
    return unpickedSessionConfiguredChoice({
      resolvesConfig: this.resolvesConfig,
      picked: this.picked,
      models,
      current
    })
  }

  /** What this session's start hands the host once: its listing, with what it resolved. */
  startListing(): AgentModelCatalogLiveListing {
    return withLiveCatalogListing(this.read(), this.configuredDefault()).catalogListing
  }

  /** The values the agent reports now, as the record's options would name them. */
  reported(): Readonly<Record<string, string>> {
    const { current } = this.read()
    return {
      ...(current.model ? { model: current.model } : {}),
      ...(current.effort ? { effort: current.effort } : {})
    }
  }

  /** The session's mode is its `mode`-category select, whatever the agent names it. */
  modeConfigId(): string {
    return this.select('mode')?.id ?? 'mode'
  }

  private select(category: string): SelectOption | null {
    const option = this.configOptions.find(
      (entry) => entry.category === category || (category === 'model' && entry.id === 'model')
    )
    return option && isSelect(option) ? option : null
  }
}

/** Images go only where the agent's row offers them and its start advertised them. */
export async function acpSessionAcceptsImages(session: {
  spec: Pick<AcpLaunchSpec, 'imagePrompts'>
  connection: Pick<AcpStructuredConnection, 'initialize'>
}): Promise<boolean> {
  return (
    session.spec.imagePrompts === true &&
    (await session.connection.initialize()).agentCapabilities?.promptCapabilities?.image === true
  )
}

/** A running child's options, and whether a message to it may carry images. */
export async function readAcpLiveOptions(
  session: Parameters<typeof acpSessionAcceptsImages>[0] & { options: AcpStructuredOptions }
) {
  const acceptsImages = await acpSessionAcceptsImages(session)
  // Only the start says what the config resolved: the session may have moved since.
  return { ...withLiveCatalogListing(session.options.read()), acceptsImages }
}

/** Only the current, still-awaited write may establish reusable option proof. */
export function writeAcpSessionOption(
  connection: Pick<AcpStructuredConnection, 'setConfigOption' | 'setModel'>,
  options: AcpStructuredOptions,
  write: AcpOptionWrite,
  bound: { agent: string; timeoutMs: number; signal?: AbortSignal; key: string }
): Promise<void> {
  const { agent, timeoutMs, signal } = bound
  if (signal?.aborted) {
    return Promise.reject(abortSignalReason(signal))
  }
  const revision = ++options.writeRevision
  options.currentProof.delete(bound.key)
  if (bound.key === 'model') {
    options.currentProof.delete('effort')
  }
  const adopt = (apply: () => void): void => {
    if (options.writeRevision !== revision) {
      throw new Error(`${agent} option write was superseded`)
    }
    apply()
    options.currentProof.add(bound.key)
  }
  const applied =
    write.method === 'config'
      ? connection
          .setConfigOption(write.configId, write.value)
          .then((result) => adopt(() => options.adoptConfigOptions(result.configOptions)))
      : connection
          .setModel(write.modelId)
          .then(() => adopt(() => options.adoptModel(write.modelId)))
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      if (options.writeRevision === revision) {
        options.writeRevision += 1
      }
      settle()
      reject(error)
    }
    const onAbort = (): void => {
      if (signal) {
        fail(abortSignalReason(signal))
      }
    }
    const timer = setTimeout(
      () => fail(new Error(`${agent} did not answer an option write within ${timeoutMs}ms`)),
      timeoutMs
    )
    const settle = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    applied.then(() => {
      settle()
      resolve()
    }, fail)
  })
}
