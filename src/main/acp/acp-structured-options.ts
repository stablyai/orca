import { abortSignalReason } from '../../shared/abort-signal-reason'

import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice,
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import type { AcpStructuredConnection } from './acp-structured-connection'
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
    private readonly dialect: Pick<
      AcpDialect,
      'modelEfforts' | 'clampsUnlistedEffort' | 'withheldCommands'
    > = {}
  ) {}

  private configOptions: SessionConfigOption[] = []
  private models: SessionModelState | null = null
  private commands: AgentSessionSlashCommand[] | undefined
  // Only new sessions resolve configured defaults; loaded sessions retain their saved choices.
  private resolvesConfig = false
  readonly picked = new Set<string>()
  /** Installed Orca policy and successful writes, distinct from native agent reports. */
  readonly applied = new Map<string, string>()
  private initialChoice: Readonly<Record<string, string>> = {}
  currentProof = new Set<string>()
  writeRevision = 0

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

  /** Native selection before any message changed this child. */
  messageDefault(): Readonly<Record<string, string>> {
    return this.initialChoice
  }

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

  /** Effort menus describe models; current session values never establish catalog defaults. */
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
      // A clamping agent's session menu says nothing about another model's menu: unknown, not none.
      const sessionMenu =
        model.id === currentModel
          ? { efforts: sessionEfforts }
          : this.dialect.clampsUnlistedEffort && effortOption && !advertised
            ? { efforts: [], effortsKnown: false as const }
            : { efforts: [] }
      return {
        ...model,
        isDefault: false,
        // Fall back to the running session's menu when the advertised menu is empty.
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

  /** Unpicked new-session default: null if unlisted, undefined if the session cannot establish it. */
  configuredDefault(): AgentModelCatalogConfiguredChoice | null | undefined {
    const { models, current } = this.read()
    return unpickedSessionConfiguredChoice({
      resolvesConfig: this.resolvesConfig,
      picked: this.picked,
      models,
      current
    })
  }

  startListing(): AgentModelCatalogLiveListing {
    return withLiveCatalogListing(this.read(), this.configuredDefault()).catalogListing
  }

  reported(): Readonly<Record<string, string>> {
    const { current } = this.read()
    return {
      ...(current.model ? { model: current.model } : {}),
      ...(current.effort ? { effort: current.effort } : {})
    }
  }

  observedCurrent(values?: Readonly<Partial<Record<string, string>>>) {
    return { ...this.read().current, reportedPermissionMode: this.reportedPermissionMode(values) }
  }

  reportedPermissionMode(
    values: Readonly<Partial<Record<string, string>>> | undefined
  ): string | null {
    if (!values) {
      return this.applied.get('permissionMode') ?? null
    }
    const current = this.select('mode')?.currentValue
    return current
      ? (Object.entries(values).find(([, value]) => value === current)?.[0] ?? null)
      : null
  }

  // Match the mode category rather than assuming an agent's config ID.
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

export async function acpSessionAcceptsImages(session: {
  connection: Pick<AcpStructuredConnection, 'initialize'>
}): Promise<boolean> {
  return (
    (await session.connection.initialize()).agentCapabilities?.promptCapabilities?.image === true
  )
}

export async function readAcpLiveOptions(
  session: Parameters<typeof acpSessionAcceptsImages>[0] & { options: AcpStructuredOptions },
  permissionModes?: Readonly<Partial<Record<string, string>>>
) {
  const acceptsImages = await acpSessionAcceptsImages(session)
  // Only startup establishes config resolution; later reads may reflect changed picks.
  const options = withLiveCatalogListing(session.options.read())
  return {
    ...options,
    current: {
      ...options.current,
      reportedPermissionMode: session.options.reportedPermissionMode(permissionModes)
    },
    acceptsImages
  }
}

/** Only the current, still-awaited write may establish reusable option proof. */
export function writeAcpSessionOption(
  connection: Pick<AcpStructuredConnection, 'setConfigOption' | 'setModel'>,
  options: AcpStructuredOptions,
  write: AcpOptionWrite,
  bound: { agent: string; timeoutMs: number; signal?: AbortSignal; key: string; value: string }
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
    options.applied.set(bound.key, bound.value)
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
