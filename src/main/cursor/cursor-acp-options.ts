import { z } from 'zod'
import type {
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import type { CursorAcpConnection } from './cursor-acp-connection'
import type { CursorAcpUpdate } from './cursor-acp-session'

const identifier = z.string().min(1).max(512)
const choiceSchema = z.object({
  value: identifier,
  name: z.string().max(512),
  description: z.string().max(4096).optional()
})
const configSchema = z.object({
  id: identifier,
  category: z.string().max(512).optional(),
  type: z.literal('select'),
  currentValue: z.string().max(512),
  options: z.union([
    z.array(choiceSchema).max(512),
    z
      .array(
        z.object({
          group: identifier,
          name: z.string().max(512),
          options: z.array(choiceSchema).max(512)
        })
      )
      .max(32)
  ])
})
const stateSchema = z
  .object({
    configOptions: z.array(z.unknown()).max(64).optional(),
    models: z
      .object({
        currentModelId: z.string().max(512),
        availableModels: z
          .array(z.object({ modelId: identifier, name: z.string().max(512) }))
          .max(512)
      })
      .optional()
  })
  .passthrough()

export class CursorAcpOptionUnavailableError extends Error {}

/** Only provider-reported values become confirmed picker state. */
export class CursorAcpOptions {
  private configs: z.infer<typeof configSchema>[] = []
  private legacyModels: z.infer<typeof stateSchema>['models']
  private commands: AgentSessionSlashCommand[] | undefined

  state(value: unknown): void {
    const parsed = stateSchema.parse(value)
    if (parsed.configOptions) {
      this.configs = parsed.configOptions.flatMap((entry) => {
        const config = configSchema.safeParse(entry)
        return config.success ? [config.data] : []
      })
    }
    if (parsed.models) {
      this.legacyModels = parsed.models
    }
  }

  update(update: CursorAcpUpdate): void {
    if (update.sessionUpdate === 'config_option_update') {
      this.state(update)
    } else if (update.sessionUpdate === 'available_commands_update') {
      const parsed = z
        .object({
          availableCommands: z
            .array(
              z.object({
                name: identifier,
                description: z.string().max(4096).optional(),
                input: z
                  .object({ hint: z.string().max(4096) })
                  .nullable()
                  .optional()
              })
            )
            .max(512)
        })
        .parse(update)
      this.commands = parsed.availableCommands.map((command) => ({
        name: command.name,
        kind: 'command',
        kindUnspecified: true,
        ...(command.description ? { description: command.description } : {}),
        ...(command.input ? { argumentHint: command.input.hint } : {})
      }))
    }
  }

  readCommands(): AgentSessionSlashCommand[] | undefined {
    return this.commands?.map((command) => ({ ...command }))
  }

  read(): AgentSessionOptionsResult {
    const model = this.configs.find((config) => config.category === 'model')
    const currentModel = model?.currentValue ?? this.legacyModels?.currentModelId ?? ''
    const choices = model
      ? model.options.flatMap((option) => ('group' in option ? option.options : [option]))
      : []
    const models = model
      ? choices.map((choice) => ({
          id: choice.value,
          label: choice.name,
          isDefault: choice.value === currentModel,
          efforts: [],
          ...(choice.description ? { description: choice.description } : {})
        }))
      : (this.legacyModels?.availableModels ?? []).map((entry) => ({
          id: entry.modelId,
          label: entry.name,
          isDefault: entry.modelId === currentModel,
          efforts: []
        }))
    return {
      models,
      current: { model: currentModel, ...(currentModel ? { confirmed: ['model'] } : {}) }
    }
  }

  async set(
    connection: CursorAcpConnection,
    sessionId: string,
    key: string,
    value: string
  ): Promise<Readonly<Record<string, string>>> {
    const current = this.read().current
    if (key === 'model' && current.model === value && current.confirmed?.includes('model')) {
      return { model: value }
    }
    const config =
      key === 'model' ? this.configs.find((entry) => entry.category === 'model') : undefined
    if (
      !config ||
      !config.options
        .flatMap((option) => ('group' in option ? option.options : [option]))
        .some((option) => option.value === value)
    ) {
      throw new CursorAcpOptionUnavailableError('Cursor ACP did not offer this model selection')
    }
    this.state(
      await connection.request('session/set_config_option', {
        sessionId,
        configId: config.id,
        value
      })
    )
    const reported = this.read().current.model
    if (reported !== value) {
      throw new Error('Cursor ACP did not confirm the requested model')
    }
    return { model: reported }
  }
}
