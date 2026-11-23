import { acpEffortOption, acpInteractionModeValue, acpSelectChoices } from './acp-select-choices'
import {
  acpCurrentModelAndEffort,
  acpReportedPermissionMode,
  acpSelectByCategory,
  acpSelectById
} from './acp-structured-option-lookup'
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

export type AcpOptionWrite =
  | { method: 'config'; configId: string; value: string }
  | { method: 'model'; modelId: string }

export class AcpStructuredOptions {
  constructor(
    private readonly dialect: Pick<
      AcpDialect,
      | 'modelEfforts'
      | 'familyEfforts'
      | 'withheldCommands'
      | 'effortChangesModel'
      | 'clampsUnlistedEffort'
      | 'builtinCommands'
      | 'skillDescription'
      | 'fastConfigId'
      | 'contextConfigId'
      | 'interactionModes'
    > = {}
  ) {}

  private forkSupport: AgentSessionOptionsResult['forkSupport'] = 'unknown'
  private configOptions: SessionConfigOption[] = []
  private models: SessionModelState | null = null
  private commands: AgentSessionSlashCommand[] | undefined
  private reportedCommands: readonly AvailableCommand[] | undefined
  private isBuiltin: (command: AvailableCommand) => boolean = () => false
  private resolvesConfig = false
  readonly picked = new Set<string>()
  readonly appliedInput = new Map<string, string>()
  readonly applied = new Map<string, string>()
  private readonly unobservedCurrent = new Set<'model' | 'effort'>()
  writeRevision = 0
  /** Orca's own writes in flight; config changes outside them are the agent's own. */
  writing = 0
  /** While Orca's hidden model command runs, its reply belongs to it, never to the chat. */
  commandReply: string | null = null
  private selectorProof: Readonly<Record<string, string | undefined>> | null = null
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
      this.appliedInput.delete('effort')
      this.appliedInput.delete('fastMode')
      this.appliedInput.delete('context')
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
    this.selectorProof = acpCurrentModelAndEffort(this.configOptions, this.models?.currentModelId)
  }

  /** `resolvedModel` marks selector proof: the model the agent's own command reported. */
  adoptOwnWrite(key: string, value: string, resolvedModel?: string): void {
    this.appliedInput.set(key, value)
    if (resolvedModel !== undefined) {
      this.selectorProof = {
        ...acpCurrentModelAndEffort(this.configOptions, this.models?.currentModelId),
        model: resolvedModel
      }
    } else if (key === 'model') {
      this.selectorProof = null
    } else if (this.selectorProof) {
      this.selectorProof = {
        ...this.selectorProof,
        effort: acpCurrentModelAndEffort(this.configOptions, this.models?.currentModelId).effort
      }
    }
  }

  matchesNativeRestoredOption(key: 'model' | 'effort', value: string): boolean {
    if (this.resolvesConfig || this.picked.has(key) || this.unobservedCurrent.has(key)) {
      return false
    }
    return (
      value.length > 0 &&
      acpCurrentModelAndEffort(this.configOptions, this.models?.currentModelId)[key] === value
    )
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
      if (acpSelectByCategory(this.configOptions, 'model')) {
        this.unobservedCurrent.delete('model')
      }
      if (acpEffortOption(this.configOptions)) {
        this.unobservedCurrent.delete('effort')
      }
    }
    const proof = this.selectorProof
    if (!proof || this.writing > 0) {
      return
    }
    const now = acpCurrentModelAndEffort(this.configOptions, this.models?.currentModelId)
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

  /** Model ids the running session lists. Empty until it has reported a model selector. */
  modelChoiceValues(): readonly string[] {
    const option = acpSelectByCategory(this.configOptions, 'model')
    return option ? acpSelectChoices(option).map((choice) => choice.value) : []
  }

  offersEffort(value: string): boolean {
    const option = acpEffortOption(this.configOptions)
    return !!(
      option &&
      (this.dialect.clampsUnlistedEffort ||
        acpSelectChoices(option).some((choice) => choice.value === value))
    )
  }

  write(key: string, value: string): AcpOptionWrite | null {
    if (key === 'fastMode') {
      const fast = acpSelectById(this.configOptions, this.dialect.fastConfigId)
      return fast ? { method: 'config', configId: fast.id, value } : null
    }
    if (key === 'context') {
      const context = acpSelectById(this.configOptions, this.dialect.contextConfigId)
      return context && acpSelectChoices(context).some((choice) => choice.value === value)
        ? { method: 'config', configId: context.id, value }
        : null
    }
    if (key === 'model') {
      const option = acpSelectByCategory(this.configOptions, 'model')
      if (option) {
        return { method: 'config', configId: option.id, value }
      }
      return this.models ? { method: 'model', modelId: value } : null
    }
    if (key === 'effort') {
      const option = acpEffortOption(this.configOptions)
      return option ? { method: 'config', configId: option.id, value } : null
    }
    if (key === 'interactionMode') {
      const option = acpSelectByCategory(this.configOptions, 'mode')
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
          acpSelectByCategory(this.configOptions, 'mode')?.currentValue !== write.value
      : value === 'plan'
  }

  /** Native choices never establish an unobserved model's capability or configured default. */
  read(): Pick<
    AgentSessionOptionsResult,
    'models' | 'current' | 'forkSupport' | 'fastModeSupport'
  > {
    const modelOption = acpSelectByCategory(this.configOptions, 'model')
    const effortOption = acpEffortOption(this.configOptions)
    const currentModel = (modelOption?.currentValue ?? this.models?.currentModelId) || undefined
    const models = acpModelMenuModels({
      dialect: this.dialect,
      modelOption,
      effortOption,
      state: this.models,
      currentModel
    })
    const contextOption = acpSelectById(this.configOptions, this.dialect.contextConfigId)
    const context = contextOption?.currentValue
    const confirmed = [
      ...(currentModel ? ['model'] : []),
      ...(effortOption ? ['effort'] : []),
      ...(context ? ['context'] : [])
    ]
    const menu = {
      models,
      forkSupport: this.forkSupport,
      current: {
        ...(currentModel ? { model: currentModel } : {}),
        ...(effortOption ? { effort: effortOption.currentValue } : {}),
        ...(context ? { context } : {}),
        confirmed
      }
    }
    return withFastModeOption(menu, acpSelectById(this.configOptions, this.dialect.fastConfigId))
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
    return acpReportedPermissionMode(
      acpSelectByCategory(this.configOptions, 'mode')?.currentValue,
      values,
      this.applied.get('permissionMode') ?? null
    )
  }

  modeConfigId(): string {
    return acpSelectByCategory(this.configOptions, 'mode')?.id ?? 'mode'
  }
}
