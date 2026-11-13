import type { AgentSessionModelOption } from '../../../../shared/agent-session/agent-session-wire'
import { contextUsageField, readAvailabilityRow } from './zcode-options-wire-shapes'
import type { ZcodeAppServerConnection } from '../../../zcode/app-server/zcode-app-server-connection-types'
import type { ZcodeStructuredSessionLiveOptions } from './zcode-live-options'
import {
  formatZcodeModelOption,
  parseZcodeModelOption
} from '../launch/zcode-structured-launch-resolution'

// zcode session options: model (`session/setModel`, value `providerId/modelId`), effort (the
// model's reasoning level, sent on the same setModel), and Build/Plan (`session/setMode`).
// Availability comes from the session's `state.updated` pushes and `session/read` projections.

export type ZcodeModelAvailability = {
  id: string
  label: string
  providerLabel?: string
  contextWindow?: number
  reasoningLevels: { value: string; label: string }[]
  defaultLevel?: string
}

export class ZcodeStructuredOptions {
  private models: ZcodeModelAvailability[] = []
  private declaredModels: { providerId: string; modelId: string }[] = []
  private thoughtLevels: { value: string; label: string }[] = []
  private currentModelId: string | null = null
  private currentMode: string | null = null
  /** The level a completed write or the projection last accepted for the current model. */
  private selectedEffort: { modelId: string; level: string } | null = null

  /**
   * The models the account push declared. The backend's `model.available` lists only the live
   * selection, so the push's ids are what keeps the other plan models selectable.
   */
  adoptDeclaredModels(
    models: readonly { providerId: string; modelId: string }[],
    thoughtLevels?: readonly { value: string; label: string }[]
  ): void {
    this.declaredModels = [...models]
    if (thoughtLevels && thoughtLevels.length > 0) {
      this.thoughtLevels = [...thoughtLevels]
    }
    this.rebuildModels()
  }

  /** The model registry snapshot a `state.updated` push carried. */
  adoptAvailability(available: unknown, current: unknown): void {
    const entries = Array.isArray(available) ? available : []
    this.models = entries.flatMap(readAvailabilityRow)
    // `state.updated` names the current model with a `ref` wrapper or directly (probe shape).
    const currentRecord = readRecord(current)
    const currentRef = readRecord(currentRecord?.ref)
    const currentProvider =
      readString(currentRef?.providerId) ?? readString(currentRecord?.providerId)
    const currentModel = readString(currentRef?.modelId) ?? readString(currentRecord?.modelId)
    if (currentProvider && currentModel) {
      this.currentModelId = formatZcodeModelOption({
        providerId: currentProvider,
        modelId: currentModel
      })
    }
    this.rebuildModels()
  }

  /** Declared entries keep every plan model selectable; availability entries add rich facts. */
  private rebuildModels(): void {
    const merged = new Map<string, ZcodeModelAvailability>()
    for (const declared of this.declaredModels) {
      const id = formatZcodeModelOption(declared)
      merged.set(id, {
        id,
        label: declared.modelId,
        reasoningLevels: this.thoughtLevels
      })
    }
    for (const model of this.models) {
      // A refreshed row must not lose its levels to an older placeholder for the same id.
      const existing = merged.get(model.id)
      const richer =
        (model.reasoningLevels.length ?? 0) >= (existing?.reasoningLevels.length ?? 0)
          ? model
          : (existing ?? model)
      merged.set(model.id, richer)
    }
    this.models = [...merged.values()]
  }

  adoptMode(mode: unknown): void {
    if (typeof mode === 'string' && mode) {
      this.currentMode = mode
    }
  }

  /** The session/read projection's settings block. */
  adoptProjectionSettings(settings: unknown): void {
    const record = readRecord(settings)
    const model = readRecord(readRecord(record?.model)?.current)
    const modelId = readString(model?.modelId)
    const providerId = readString(model?.providerId)
    if (modelId && modelId.includes('/')) {
      this.currentModelId = modelId
    } else if (modelId && providerId) {
      this.currentModelId = formatZcodeModelOption({ providerId, modelId })
    }
    const level = readString(readRecord(model?.options)?.reasoningLevel)
    this.selectedEffort =
      level && this.currentModelId ? { modelId: this.currentModelId, level } : this.selectedEffort
    const mode = readRecord(record?.mode)
    this.adoptMode(readString(mode?.current))
  }

  get modelId(): string | null {
    return this.currentModelId
  }

  /** The picker label of a model id, or its bare model name when nothing lists it. */
  modelLabelOf(id: string | null): string | null {
    if (!id) {
      return null
    }
    return this.models.find((entry) => entry.id === id)?.label ?? id.split('/').at(-1) ?? id
  }

  get mode(): string | null {
    return this.currentMode
  }

  private effortOf(modelId: string | null): string | undefined {
    const found = this.models.find((model) => model.id === modelId)
    return found?.defaultLevel
  }

  /** The level the session last accepted for this model, else the model's default. */
  private effortFor(modelId: string | null): string | undefined {
    if (modelId && this.selectedEffort?.modelId === modelId) {
      return this.selectedEffort.level
    }
    return this.effortOf(modelId)
  }

  /** Reads the session's options as the wire result. */
  live(contextUsage: { used?: number; window?: number } | null): ZcodeStructuredSessionLiveOptions {
    const models: AgentSessionModelOption[] = this.models.map((model) => ({
      id: model.id,
      label: model.label,
      description: model.providerLabel ?? model.id,
      isDefault: false,
      ...(model.defaultLevel ? { defaultEffort: model.defaultLevel } : {}),
      efforts: model.reasoningLevels
    }))
    const permissionMode = this.permissionModeOf(this.currentMode)
    return {
      models,
      // Availability arrives only after a session's first state push; without it the host catalog
      // listing is the inventory and this answer must not wipe it.
      ...(models.length === 0 ? { modelsKnown: false as const } : {}),
      current: {
        ...(this.currentModelId ? { model: this.currentModelId } : {}),
        ...(this.effortFor(this.currentModelId)
          ? { effort: this.effortFor(this.currentModelId) }
          : {}),
        // Build/Plan is zcode's own mode switch; the permission modes ride the same setting.
        interactionMode: this.currentMode === 'plan' ? 'plan' : 'default',
        ...(permissionMode ? { permissionMode } : {})
      },
      conversationCommands: ['compact'],
      ...(contextUsage ? { contextUsage: contextUsageField(contextUsage) } : {})
    }
  }

  /** The level a switch carries: the target's own default, else the chat's current, else the lowest. */
  private levelForSwitch(modelId: string): string {
    const declared = this.models.find((entry) => entry.id === modelId)
    return (
      declared?.defaultLevel ??
      this.effortOf(this.currentModelId) ??
      this.models.find((entry) => entry.id === this.currentModelId)?.reasoningLevels[0]?.value ??
      declared?.reasoningLevels[0]?.value ??
      this.thoughtLevels[0]?.value ??
      'low'
    )
  }

  /** Orca's permission vocabulary for the zcode mode a session reports; plan is not a permission. */
  private permissionModeOf(mode: string | null): string | undefined {
    if (mode === 'build') {
      return 'ask'
    }
    if (mode === 'edit') {
      return 'accept-edits'
    }
    if (mode === 'auto') {
      return 'auto'
    }
    if (mode === 'yolo') {
      return 'full-access'
    }
    return undefined
  }

  /** Writes one option; returns the applied options map. */
  async write(
    connection: ZcodeAppServerConnection,
    providerSessionId: string,
    key: string,
    value: string,
    timeoutMs: number | null
  ): Promise<Record<string, string>> {
    if (key === 'model') {
      const model = parseZcodeModelOption(value)
      if (!model) {
        throw new Error(
          `zcode model options are provider/model pairs, not ${JSON.stringify(value)}`
        )
      }
      const level = this.levelForSwitch(value)
      await connection.request(
        'session/setModel',
        {
          sessionId: providerSessionId,
          model: {
            providerId: model.providerId,
            modelId: model.modelId,
            // Models whose menu demands a level (GLM-5.3-Flash) refuse a bare switch; the
            // follow-up effort write carries the person's real pick.
            options: { reasoningLevel: level }
          },
          persistAsWorkspaceLastUsed: false
        },
        { timeoutMs }
      )
      this.currentModelId = value
      this.selectedEffort = { modelId: value, level }
      return { model: value }
    }
    if (key === 'effort') {
      const model = parseZcodeModelOption(this.currentModelId ?? '')
      if (!model) {
        throw new Error('zcode effort follows a selected model; pick a model first')
      }
      await connection.request(
        'session/setModel',
        {
          sessionId: providerSessionId,
          model: {
            providerId: model.providerId,
            modelId: model.modelId,
            options: { reasoningLevel: value }
          },
          persistAsWorkspaceLastUsed: false
        },
        { timeoutMs }
      )
      this.selectedEffort = { modelId: this.currentModelId ?? '', level: value }
      return { effort: value }
    }
    if (key === 'interactionMode') {
      const mode = value === 'plan' ? 'plan' : 'build'
      await connection.request(
        'session/setMode',
        { sessionId: providerSessionId, mode },
        { timeoutMs }
      )
      this.currentMode = mode
      return { interactionMode: value }
    }
    if (key === 'permissionMode') {
      // Orca's permission vocabulary onto zcode's collaboration mode (Build/Plan rides separately).
      const byMode: Record<string, string> = {
        ask: 'build',
        'accept-edits': 'edit',
        auto: 'auto',
        'full-access': 'yolo'
      }
      const mode = byMode[value]
      if (!mode) {
        throw new Error(`zcode has no collaboration mode for permission ${value}`)
      }
      await connection.request(
        'session/setMode',
        { sessionId: providerSessionId, mode },
        { timeoutMs }
      )
      this.currentMode = mode
      return { permissionMode: value }
    }
    throw new Error(`zcode offers no session option named ${key}`)
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
