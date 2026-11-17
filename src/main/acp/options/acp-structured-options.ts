import {
  acpEffortOption,
  acpSelectOffers,
  acpSelectOption,
  type AcpSelectOption
} from './acp-select-choices'
import { buildAcpOptionWrite, readAcpOptionsMenu, type AcpOptionWrite } from './acp-model-menu'
import { acpInitializeForkSupport } from '../capabilities/acp-fork-support'
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

export type { AcpOptionWrite }

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
      | 'fastConfigId'
    > = {}
  ) {}

  private forkSupport: AgentSessionOptionsResult['forkSupport'] = 'unknown'
  private configOptions: SessionConfigOption[] = []
  private models: SessionModelState | null = null
  private buildMode = 'default'
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
      // Each model has its own effort and Fast defaults, so both are written again.
      this.appliedInput.delete('effort')
      this.appliedInput.delete('fastMode')
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
    const mode = this.select('mode')?.currentValue
    this.buildMode = mode && mode !== 'plan' ? mode : 'default'
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

  matchesNativeRestoredOption(key: 'model' | 'effort' | 'interactionMode', value: string): boolean {
    if (
      this.resolvesConfig ||
      this.picked.has(key) ||
      (key !== 'interactionMode' && this.unobservedCurrent.has(key))
    ) {
      return false
    }
    return value.length > 0 && this.currentValues()[key] === value
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
      const mode = this.select('mode')?.currentValue
      if (mode && mode !== 'plan') {
        this.buildMode = mode
      }
      const appliedMode = this.appliedInput.get('interactionMode')
      if (appliedMode !== undefined && this.currentInteractionMode() !== appliedMode) {
        this.appliedInput.delete('interactionMode')
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
      .map((command) => ({
        name: command.name,
        kind: 'command',
        ...(command.description ? { description: command.description } : {}),
        ...(command.input?.hint ? { argumentHint: command.input.hint } : {}),
        ...(this.isBuiltin(command) ? { builtin: true as const } : {})
      }))
  }

  readCommands(): AgentSessionSlashCommand[] | undefined {
    return this.commands
  }

  offersEffort(value: string): boolean {
    const option = this.effortOption()
    return !!(option && (this.dialect.clampsUnlistedEffort || acpSelectOffers(option, value)))
  }

  hasModeOption(): boolean {
    return this.select('mode') !== null
  }

  offersMode(value: string): boolean {
    return acpSelectOffers(this.select('mode'), value)
  }

  adoptBuildMode(mode: string): void {
    if (mode !== 'plan') {
      this.buildMode = mode
    }
  }

  write(key: string, value: string): AcpOptionWrite | null {
    return buildAcpOptionWrite({
      key,
      value,
      configOptions: this.configOptions,
      models: this.models,
      fastConfigId: this.dialect.fastConfigId,
      buildMode: this.buildMode
    })
  }

  /** Native choices never establish an unobserved model's capability or configured default. */
  read(): Pick<
    AgentSessionOptionsResult,
    'models' | 'current' | 'forkSupport' | 'fastModeSupport'
  > {
    return readAcpOptionsMenu({
      configOptions: this.configOptions,
      models: this.models,
      dialect: this.dialect,
      forkSupport: this.forkSupport
    })
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
      ...(current.effort ? { effort: current.effort } : {}),
      ...(current.interactionMode ? { interactionMode: current.interactionMode } : {})
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
      effort: this.effortOption()?.currentValue,
      interactionMode: this.currentInteractionMode()
    }
  }

  private currentInteractionMode(): 'default' | 'plan' | undefined {
    return this.offersMode('plan')
      ? this.select('mode')?.currentValue === 'plan'
        ? 'plan'
        : 'default'
      : undefined
  }

  private effortOption(): AcpSelectOption | null {
    return acpEffortOption(this.configOptions)
  }

  private select(category: string): AcpSelectOption | null {
    return acpSelectOption(this.configOptions, category)
  }
}
