// What a running ACP agent reports about its own choices — config options (model, reasoning
// effort), the older model list, and its `/` commands — as Orca's option and command surfaces.
// Kept as the agent last reported it; nothing here is guessed or listed by Orca itself.

import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice,
  AgentSessionOptionsResult,
  AgentSessionSlashCommand
} from '../../shared/agent-session-wire'
import { isAcpStructuredOptionKey } from './acp-structured-agent-definitions'
import { AcpRpcError } from './acp-errors'
import type { AcpStructuredConnection } from './acp-structured-connection'
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
  private configOptions: SessionConfigOption[] = []
  private models: SessionModelState | null = null
  private commands: AgentSessionSlashCommand[] | undefined

  /** The session state a new, load or resume response reported. */
  adoptSession(response: {
    configOptions?: SessionConfigOption[] | null
    models?: SessionModelState | null
  }): void {
    this.configOptions = response.configOptions ?? []
    this.models = response.models ?? null
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
    this.commands = commands.map((command) => ({
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

  read(): Pick<AgentSessionOptionsResult, 'models' | 'current'> {
    const modelOption = this.select('model')
    const effortOption = this.select('thought_level')
    const efforts: AgentSessionOptionChoice[] = effortOption
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
    const models: AgentSessionModelOption[] = listed.map((model) => ({
      ...model,
      isDefault: model.id === currentModel,
      efforts,
      ...(effortOption ? { defaultEffort: effortOption.currentValue } : {})
    }))
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

  /** The values the agent reports now, as the record's options would name them. */
  reported(): Readonly<Record<string, string>> {
    const { current } = this.read()
    return {
      ...(current.model ? { model: current.model } : {}),
      ...(current.effort ? { effort: current.effort } : {})
    }
  }

  private select(category: string): SelectOption | null {
    const option = this.configOptions.find(
      (entry) => entry.category === category || (category === 'model' && entry.id === 'model')
    )
    return option && isSelect(option) ? option : null
  }
}

/** Sends a pick and adopts the agent's answer, even one that lands after the wait gave up: that is
 *  still what the agent runs. The wait fails at `timeoutMs`, or once `signal` aborts. */
export function writeAcpSessionOption(
  connection: Pick<AcpStructuredConnection, 'setConfigOption' | 'setModel'>,
  options: AcpStructuredOptions,
  write: AcpOptionWrite,
  bound: { agent: string; timeoutMs: number; signal?: AbortSignal }
): Promise<void> {
  const { agent, timeoutMs, signal } = bound
  if (signal?.aborted) {
    return Promise.reject(new Error(`${agent} option write abandoned before it was sent`))
  }
  const applied =
    write.method === 'config'
      ? connection
          .setConfigOption(write.configId, write.value)
          .then((result) => options.adoptConfigOptions(result.configOptions))
      : connection.setModel(write.modelId).then(() => options.adoptModel(write.modelId))
  return new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      settle()
      reject(error)
    }
    const onAbort = (): void => fail(new Error(`${agent} option write abandoned`))
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

/** Re-applies the chat's saved picks to the agent's new session; a pick it refuses is skipped and
 *  reported, never retried. */
export async function restoreAcpSessionOptions(
  connection: Pick<AcpStructuredConnection, 'setConfigOption' | 'setModel'>,
  options: AcpStructuredOptions,
  saved: Readonly<Record<string, string>> | undefined
): Promise<string[]> {
  const skipped: string[] = []
  for (const [key, value] of Object.entries(saved ?? {})) {
    const reported = options.reported()
    if (!isAcpStructuredOptionKey(key) || reported[key] === value) {
      continue
    }
    const write = options.write(key, value)
    try {
      if (write?.method === 'config') {
        options.adoptConfigOptions(
          (await connection.setConfigOption(write.configId, value)).configOptions
        )
      } else if (write?.method === 'model') {
        await connection.setModel(write.modelId)
        options.adoptModel(write.modelId)
      } else {
        skipped.push(key)
      }
    } catch (error) {
      if (!(error instanceof AcpRpcError)) {
        throw error
      }
      skipped.push(key)
    }
  }
  return skipped
}
