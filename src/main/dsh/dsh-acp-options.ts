import { z } from 'zod'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { DshAcpConnection } from './dsh-acp-connection'
import type { DshAcpUpdate } from './dsh-acp-session'

const identifier = z.string().min(1).max(512)
const choice = z.object({
  value: identifier,
  name: z.string().max(512),
  description: z.string().max(4096).optional()
})
const config = z.object({
  id: identifier,
  category: z.string().max(512).optional(),
  type: z.literal('select'),
  currentValue: z.string().max(512),
  options: z.union([
    z.array(choice).max(512),
    z
      .array(
        z.object({
          group: identifier,
          name: z.string().max(512),
          options: z.array(choice).max(512)
        })
      )
      .max(32)
  ])
})
const state = z.object({ configOptions: z.array(config).max(64) })
type Config = z.infer<typeof config>
const choices = (entry: Config) =>
  entry.options.flatMap((option) => ('group' in option ? option.options : [option]))

export class DshAcpOptionUnavailableError extends Error {}

export class DshAcpOptions {
  private configs: Config[] = []
  state(value: unknown): void {
    this.configs = state.parse(value).configOptions
  }
  update(update: DshAcpUpdate): void {
    if (update.sessionUpdate === 'config_option_update') {
      this.state(update)
    }
  }
  private option(key: string): Config | undefined {
    return this.configs.find((entry) =>
      key === 'model'
        ? entry.category === 'model'
        : key === 'effort'
          ? entry.category === 'thought_level'
          : entry.id === key
    )
  }
  read(): AgentSessionOptionsResult {
    const model = this.option('model')
    const effort = this.option('effort')
    return {
      conversationCommands: ['clear'],
      models: model
        ? choices(model).map((option) => ({
            id: option.value,
            label: option.name,
            isDefault: option.value === model.currentValue,
            efforts: effort
              ? choices(effort).map((value) => ({ value: value.value, label: value.name }))
              : [],
            ...(option.description ? { description: option.description } : {})
          }))
        : [],
      current: {
        model: model?.currentValue ?? '',
        ...(effort ? { effort: effort.currentValue } : {}),
        confirmed: [...(model ? ['model'] : []), ...(effort ? ['effort'] : [])]
      }
    }
  }
  async set(
    connection: DshAcpConnection,
    sessionId: string,
    key: string,
    value: string
  ): Promise<Readonly<Record<string, string>>> {
    const offered = this.option(key)
    if (!offered || !choices(offered).some((choice) => choice.value === value)) {
      throw new DshAcpOptionUnavailableError(
        'DeepSeek Harness did not offer this configuration value'
      )
    }
    this.state(
      await connection.request('session/set_config_option', {
        sessionId,
        configId: offered.id,
        value
      })
    )
    if (this.option(key)?.currentValue !== value) {
      throw new Error('DeepSeek Harness did not confirm the configuration value')
    }
    const current = this.read().current
    return {
      ...(current.model ? { model: current.model } : {}),
      ...(current.effort ? { effort: current.effort } : {})
    }
  }
}
