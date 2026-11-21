import { acpEffortOption, acpInteractionModeValue, acpSelectChoices } from './acp-select-choices'
import { acpModelMenuModels, withFastModeOption } from './acp-model-menu'
import { acpInitializeForkSupport } from '../capabilities/acp-fork-support'
import { acpSessionSlashCommand } from './acp-session-slash-command'
import type { AgentSessionSlashCommand } from '../../../shared/agent-session/agent-session-wire'

import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import {
  unpickedSessionConfiguredChoice,
  withLiveCatalogListing,
  type AgentModelCatalogConfiguredChoice,
  type AgentModelCatalogLiveListing
} from '../../native-chat/agent-model-catalog/agent-model-catalog-entry'

import type {
  AvailableCommand,
  InitializeResponse,
  SessionConfigOption,
  SessionModelState
} from '../generated/acp-protocol.generated'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

export type AcpOptionWrite =
  | { method: 'config'; configId: string; value: string }
  | { method: 'model'; modelId: string }

function isSelect(option: SessionConfigOption): option is SelectOption {
  return option.type === 'select'
}

export class AcpStructuredOptions {
  constructor(
    private readonly dialect: Pick<
      AcpDialect,
      | 'modelEfforts'
      | 'familyEfforts'
      | 'withheldCommands'
      | 'chatModelIds'
      | 'effortChangesModel'
      | 'clampsUnlistedEffort'
      | 'builtinCommands'
      | 'skillDescription'
      | 'fastConfigId'
      | 'thinkingConfigId'
      | 'interactionModes'
    > = {}
  ) {}

  private forkSupport: AgentSessionOptionsResult['forkSupport'] = 'unknown'
  /** As the agent last reported them; replace through `adoptConfigOptions`. */
  configOptions: SessionConfigOption[] = []
  private models: SessionModelState | null = null
  private commands: AgentSessionSlashCommand[] | undefined
  private reportedCommands: readonly AvailableCommand[] | undefined
  private isBuiltin: (command: AvailableCommand) => boolean = () => false
  // Only new sessions resolve configured defaults; loaded sessions retain their saved choices.
  private resolvesConfig = false
  readonly picked = new Set<string>()
  readonly appliedInput = new Map<string, string>()
  readonly applied = new Map<string, string>()
  // A control without refreshed options leaves the prior current values unproven.
  private readonly unobservedCurrent = new Set<'model' | 'effort'>()
  writeRevision = 0
  /** Orca's own writes in flight; config changes outside them are the agent's own. */
  writing = 0
  /** While Orca's hidden model command runs, its reply belongs to it, never to the chat. */
  commandReply: string | null = null
  // What a launch-line or model-command selection resolved to. The agent never echoes the raw
  // selector, so a concrete change away from this retires it; ordinary control proof never does.
  private selectorProof: Readonly<Record<string, string | undefined>> | null = null

  // Native controls a withdrawn send stopped waiting for; their call deadline bounds each one.
  private readonly unsettled = new Set<Promise<unknown>>()

  /** Later controls and prompts wait for it, and its key is re-sent once it settles. */
  holdUntilSettled(native: Promise<unknown>, key: string): void {
    this.unsettled.add(native)
    const settled = (): void => {
      this.unsettled.delete(native)
      this.invalidateInput(key)
    }
    native.then(settled, settled)
  }

  /** Resolves once no withdrawn control can still land at the agent. */
  async whenControlsSettle(): Promise<void> {
    while (this.unsettled.size > 0) {
      await Promise.allSettled(this.unsettled)
    }
  }

  invalidateInput(key: string): void {
    this.appliedInput.delete(key)
    if (key === 'model' || key === 'effort') {
      this.unobservedCurrent.add(key)
    }
    if (key === 'model') {
      // Each model has its own effort, thinking and Fast defaults, so all are written again.
      this.appliedInput.delete('effort')
      this.appliedInput.delete('fastMode')
      this.appliedInput.delete('thinking')
      this.unobservedCurrent.add('effort')
    }
    if (key === 'effort' && this.dialect.effortChangesModel) {
      this.appliedInput.delete('model')
      this.unobservedCurrent.add('model')
    }
  }

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
    this.appliedInput.clear()
    this.unobservedCurrent.clear()
    this.selectorProof = null
  }

  /** The session runs a model the launch line applied, so sends need not write it again. */
  adoptLaunchModel(model: string): void {
    this.appliedInput.set('model', model)
    this.picked.add('model')
    this.selectorProof = this.currentValues()
  }

  /** `resolvedModel` marks selector proof: the model the agent's own command reported. */
  adoptOwnWrite(key: string, value: string, resolvedModel?: string): void {
    this.appliedInput.set(key, value)
    if (resolvedModel !== undefined) {
      this.selectorProof = { ...this.currentValues(), model: resolvedModel }
    } else if (key === 'model') {
      this.selectorProof = null
    } else if (this.selectorProof) {
      this.selectorProof = { ...this.selectorProof, effort: this.currentValues().effort }
    }
  }

  matchesNativeRestoredOption(key: 'model' | 'effort', value: string): boolean {
    if (this.resolvesConfig || this.picked.has(key) || this.unobservedCurrent.has(key)) {
      return false
    }
    const native = (key === 'model' && this.dialect.chatModelIds?.get(value)) || value
    return value.length > 0 && this.currentValues()[key] === native
  }

  notePick(key: string): void {
    this.picked.add(key)
  }

  adoptConfigOptions(configOptions: SessionConfigOption[] | null | undefined): void {
    if (!configOptions) {
      return
    }
    this.configOptions = configOptions
    if (this.writing === 0 && this.unsettled.size === 0) {
      if (this.select('model')) {
        this.unobservedCurrent.delete('model')
      }
      if (this.effortOption()) {
        this.unobservedCurrent.delete('effort')
      }
    }
    const proof = this.selectorProof
    if (!proof || this.writing > 0) {
      return
    }
    // A role or :level selector carries thinking too; missing values are no concrete change.
    const now = this.currentValues()
    const drifted = (key: string) =>
      now[key] !== undefined && proof[key] !== undefined && now[key] !== proof[key]
    if (drifted('model') || drifted('effort')) {
      this.selectorProof = null
      this.appliedInput.delete('model')
      this.appliedInput.delete('effort')
    }
  }

  adoptModel(modelId: string): void {
    if (this.models) {
      this.models = { ...this.models, currentModelId: modelId }
    }
  }

  /** Each process proves its own built-ins; session rows alone cannot. */
  adoptInitialize(initialized: InitializeResponse): void {
    this.forkSupport = acpInitializeForkSupport(initialized)
    this.isBuiltin = this.dialect.builtinCommands?.(initialized) ?? (() => false)
    if (this.reportedCommands) {
      this.adoptCommands(this.reportedCommands)
    }
  }

  adoptCommands(commands: readonly AvailableCommand[]): void {
    const withheld = this.dialect.withheldCommands ?? []
    this.reportedCommands = commands
    this.commands = commands
      .filter((command) => !withheld.includes(command.name))
      .map((command) => acpSessionSlashCommand(command, this.dialect, this.isBuiltin(command)))
  }

  readCommands(): AgentSessionSlashCommand[] | undefined {
    return this.commands
  }

  offersEffort(value: string): boolean {
    const option = this.effortOption()
    return !!(
      option &&
      (this.dialect.clampsUnlistedEffort ||
        acpSelectChoices(option).some((choice) => choice.value === value))
    )
  }

  write(key: string, value: string): AcpOptionWrite | null {
    if (key === 'fastMode' || key === 'thinking') {
      const option = this.idSelect(
        key === 'fastMode' ? this.dialect.fastConfigId : this.dialect.thinkingConfigId
      )
      return option ? { method: 'config', configId: option.id, value } : null
    }
    if (key === 'model') {
      const option = this.select('model')
      const model = this.dialect.chatModelIds?.get(value) ?? value
      if (option) {
        return { method: 'config', configId: option.id, value: model }
      }
      return this.models ? { method: 'model', modelId: model } : null
    }
    if (key === 'effort') {
      const option = this.effortOption()
      return option ? { method: 'config', configId: option.id, value } : null
    }
    if (key === 'interactionMode') {
      const option = this.select('mode')
      const native = acpInteractionModeValue(this.dialect.interactionModes, option, value)
      return option && native ? { method: 'config', configId: option.id, value: native } : null
    }
    return null
  }

  /** Unrunnable Plan is refused, unrunnable Build skipped; only Orca's confirmed write proves the mode. */
  needsInteractionMode(value: string): boolean {
    const write = this.write('interactionMode', value)
    return write?.method === 'config'
      ? this.appliedInput.get('interactionMode') !== value ||
          this.select('mode')?.currentValue !== write.value
      : value === 'plan'
  }

  /** Native choices never establish an unobserved model's capability or configured default. */
  read(): Pick<
    AgentSessionOptionsResult,
    'models' | 'current' | 'forkSupport' | 'fastModeSupport'
  > {
    const modelOption = this.select('model')
    const effortOption = this.effortOption()
    const currentModel = (modelOption?.currentValue ?? this.models?.currentModelId) || undefined
    const models = acpModelMenuModels({
      dialect: this.dialect,
      modelOption,
      effortOption,
      state: this.models,
      currentModel
    })
    const confirmed = [...(currentModel ? ['model'] : []), ...(effortOption ? ['effort'] : [])]
    const menu = {
      models,
      forkSupport: this.forkSupport,
      current: {
        ...(currentModel ? { model: currentModel } : {}),
        ...(effortOption ? { effort: effortOption.currentValue } : {}),
        confirmed
      }
    }
    return withFastModeOption(menu, this.idSelect(this.dialect.fastConfigId))
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

  // Only the running values, so config notifications don't project the whole catalog again.
  private currentValues(): Readonly<Record<string, string | undefined>> {
    return {
      model: (this.select('model')?.currentValue ?? this.models?.currentModelId) || undefined,
      effort: this.effortOption()?.currentValue
    }
  }

  private effortOption(): SelectOption | null {
    return acpEffortOption(this.configOptions)
  }

  private idSelect(id: string | undefined): SelectOption | null {
    const option = id ? this.configOptions.find((entry) => entry.id === id) : undefined
    return option && isSelect(option) ? option : null
  }

  private select(category: string): SelectOption | null {
    const option = this.configOptions.find(
      (entry) => entry.category === category || (category === 'model' && entry.id === 'model')
    )
    return option && isSelect(option) ? option : null
  }
}
