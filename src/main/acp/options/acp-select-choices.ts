import {
  SessionConfigSelectGroupSchema,
  SessionConfigSelectOptionSchema,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionModelState
} from '../generated/acp-protocol.generated'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import { isAgentSessionInteractionMode } from '../../../shared/agent-session/options/permissions/agent-session-interaction-mode'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

export function acpSelectChoices(option: SelectOption): SessionConfigSelectOption[] {
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

/** The model select's choices, or the legacy model list when the agent offers no select. */
export function acpListedModels(
  modelOption: SelectOption | null,
  models: SessionModelState | null
): { id: string; label: string; description?: string }[] {
  return modelOption
    ? acpSelectChoices(modelOption).map((choice) => ({
        id: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {})
      }))
    : (models?.availableModels.map((model) => ({
        id: model.modelId,
        label: model.name,
        ...(model.description ? { description: model.description } : {})
      })) ?? [])
}

/** The options with a mode the agent reported apart from them; null when it lists no mode select. */
export function acpWithCurrentMode(
  options: readonly SessionConfigOption[],
  modeId: string
): SessionConfigOption[] | null {
  const isMode = (option: SessionConfigOption): option is SelectOption =>
    option.category === 'mode' && option.type === 'select'
  return options.some(isMode)
    ? options.map((option) => (isMode(option) ? { ...option, currentValue: modeId } : option))
    : null
}

/** An agent may list an on/off thinking switch beside its effort levels; effort is the longer menu. */
export function acpEffortOption(options: readonly SessionConfigOption[]): SelectOption | null {
  let effort: SelectOption | null = null
  for (const option of options) {
    if (
      option.category === 'thought_level' &&
      option.type === 'select' &&
      (!effort || acpSelectChoices(option).length > acpSelectChoices(effort).length)
    ) {
      effort = option
    }
  }
  return effort
}

/** The agent's own mode value for Orca's interaction mode, when its mode select offers it. */
export function acpInteractionModeValue(
  interactionModes: AcpDialect['interactionModes'],
  modeOption: SelectOption | null,
  value: string
): string | null {
  const native = isAgentSessionInteractionMode(value) ? interactionModes?.[value] : undefined
  return native &&
    modeOption &&
    acpSelectChoices(modeOption).some((choice) => choice.value === native)
    ? native
    : null
}

/** Orca's Build/Plan as the agent's mode values. Where Plan is one of the agent's permission
 *  levels, Build returns to the level that ran before it. */
export class AcpInteractionModeChoice {
  private lastBuild: string | undefined

  // Read lazily: the options that own this choice take the dialect in their own constructor.
  constructor(
    private readonly dialect: () => Pick<AcpDialect, 'interactionModes' | 'planPermissionMode'>
  ) {}

  write(
    modeOption: SelectOption | null,
    value: string
  ): { method: 'config'; configId: string; value: string } | null {
    const plan = this.dialect().planPermissionMode
    if (plan && modeOption && modeOption.currentValue !== plan.plan) {
      this.lastBuild = modeOption.currentValue
    }
    const modes = plan
      ? { default: this.build()!, plan: plan.plan }
      : this.dialect().interactionModes
    const native = acpInteractionModeValue(modes, modeOption, value)
    return modeOption && native
      ? { method: 'config', configId: modeOption.id, value: native }
      : null
  }

  holds(current: unknown): boolean {
    return current !== undefined && current === this.dialect().planPermissionMode?.plan
  }

  /** The permission level running now; in Plan, the one Build returns to. */
  running(current: string | undefined): string | undefined {
    return this.holds(current) ? this.build() : current
  }

  /** A permission picked during Plan applies once the chat returns to Build. */
  adoptBuild(value: string): void {
    this.lastBuild = value
  }

  build(): string | undefined {
    const plan = this.dialect().planPermissionMode
    return plan && (this.lastBuild ?? plan.build)
  }
}
