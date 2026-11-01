import { withLiveCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { z } from 'zod'
import { PI_THINKING_LEVELS } from '../../shared/structured-agent-session-effective-effort'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type {
  AgentSessionCommandsResult,
  AgentSessionOptionsResult
} from '../../shared/agent-session-wire'
import { piRpcModelSchema, piRpcStateSchema } from './rpc-protocol'

export type PiRpcRequester = {
  request(
    command: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number | null }
  ): Promise<unknown>
}

const modelSchema = piRpcModelSchema.safeExtend({
  provider: z.string().min(1),
  id: z.string().min(1),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional()
})
const modelsSchema = z.object({ models: z.array(modelSchema) })
const stateSchema = piRpcStateSchema.safeExtend({
  model: modelSchema.nullish()
})
const commandsSchema = z.object({
  commands: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      source: z.string().optional()
    })
  )
})

export function piModelOptionId(provider: string, modelId: string): string {
  if (!provider || !modelId || provider.includes('/')) {
    throw new Error('Pi model requires an explicit provider and model ID')
  }
  return `${provider}/${modelId}`
}

export function parsePiModelOptionId(value: string): { provider: string; modelId: string } {
  const slash = value.indexOf('/')
  if (slash < 1 || slash === value.length - 1) {
    throw new Error('Pi model requires an explicit provider and model ID')
  }
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

/** Native inventory projection shared by running chats and the pre-session catalog. */
export async function readPiRpcModelOptions(
  rpc: PiRpcRequester
): Promise<AgentSessionOptionsResult['models']> {
  const models = modelsSchema.parse(await rpc.request('get_available_models')).models
  return models.map((model) => {
    const id = piModelOptionId(model.provider, model.id)
    const efforts =
      model.reasoning !== true
        ? []
        : PI_THINKING_LEVELS.filter((level) => {
            const mapped = model.thinkingLevelMap?.[level]
            return (
              mapped !== null && ((level !== 'xhigh' && level !== 'max') || mapped !== undefined)
            )
          }).map((level) => ({ value: level, label: level }))
    return {
      id,
      label: model.name || id,
      isDefault: false,
      efforts
    }
  })
}

export async function readPiRpcSessionOptions(
  rpc: PiRpcRequester,
  beforeStateRead?: () => void
): Promise<AgentSessionOptionsResult> {
  const listed = await readPiRpcModelOptions(rpc)
  beforeStateRead?.()
  const state = stateSchema.parse(await rpc.request('get_state'))
  return {
    models: listed,
    current: piRpcStateOptions(state)
  }
}

export function piRpcStateOptions(state: {
  model?: { provider: string; id: string } | null
  thinkingLevel?: string
}): AgentSessionOptionsResult['current'] {
  const model = state.model ? piModelOptionId(state.model.provider, state.model.id) : undefined
  return {
    model: model ?? '',
    ...(state.thinkingLevel ? { effort: state.thinkingLevel } : {}),
    confirmed: [...(model ? ['model'] : []), ...(state.thinkingLevel ? ['effort'] : [])]
  }
}

export type PiRpcOptionWrite = { pending: boolean }
export type PiRpcOptionProof = {
  current: Map<string, string>
  writes: Map<string, PiRpcOptionWrite>
}

/** Held reports belong to one child; a report cannot cross its native write lifetime. */
export class PiRpcOptionObservations {
  private observed: AgentSessionOptionsResult = { models: [], modelsKnown: false, current: {} }
  private writes = new Map<string, PiRpcOptionWrite>()
  private consumed = new Map<string, string>()
  constructor(
    private readonly proof: PiRpcOptionProof,
    private readonly current: () => boolean
  ) {}

  seed(state: Parameters<typeof piRpcStateOptions>[0]): void {
    this.observed = { models: [], modelsKnown: false, current: piRpcStateOptions(state) }
  }

  prepare(): (options: AgentSessionOptionsResult) => boolean {
    const writes = new Map(this.proof.writes)
    const consumed = new Map(this.proof.current)
    return (options) => {
      if (!this.current()) {
        return false
      }
      if (
        [...this.proof.writes].some(([key, token]) => token.pending || writes.get(key) !== token)
      ) {
        this.observed = {
          ...this.observed,
          models: options.models,
          modelsKnown: options.modelsKnown
        }
        return false
      }
      this.observed = options
      this.writes = writes
      this.consumed = consumed
      return true
    }
  }

  prepareState(report: (current: AgentSessionOptionsResult['current']) => void) {
    const observe = this.prepare()
    return (state: Parameters<typeof piRpcStateOptions>[0]) => {
      const current = piRpcStateOptions(state)
      if (observe({ ...this.observed, current })) {
        report(current)
      }
    }
  }

  read() {
    const current = { ...this.observed.current }
    const confirmed = new Set(current.confirmed)
    for (const key of ['model', 'effort'] as const) {
      if (
        this.proof.writes.get(key)?.pending ||
        this.proof.writes.get(key) !== this.writes.get(key)
      ) {
        current[key] = this.proof.current.get(key)
        confirmed.delete(key)
      }
    }
    const answer = { ...this.observed, current: { ...current, confirmed: [...confirmed] } }
    const writes = this.writes
    const consumed = this.consumed
    return {
      ...withLiveCatalogListing(answer),
      projectCurrent: (saved: Readonly<Record<string, string>>) => {
        const model = saved.model ?? answer.current.model
        const unchanged =
          this.current() &&
          ['model', 'effort'].every(
            (key) =>
              !this.proof.writes.get(key)?.pending &&
              this.proof.writes.get(key) === writes.get(key) &&
              this.proof.current.get(key) === consumed.get(key)
          )
        const sameApplication =
          unchanged &&
          model === answer.current.model &&
          model === consumed.get('model') &&
          saved.effort === consumed.get('effort')
        const useActual =
          unchanged &&
          model === answer.current.model &&
          (saved.effort === undefined || sameApplication)
        return {
          ...answer.current,
          // Unapplied intent stays raw in transport so later catalogs can rederive the display.
          effort: useActual ? answer.current.effort : (saved.effort ?? answer.current.effort),
          confirmed: answer.current.confirmed.filter(
            (key) => unchanged && (key !== 'effort' || useActual)
          )
        }
      }
    }
  }
}

export async function applyPiRpcSessionOption(
  rpc: PiRpcRequester,
  selected: Map<string, string>,
  key: string,
  value: string,
  options: { timeoutMs?: number | null; signal?: AbortSignal } = {},
  proof?: PiRpcOptionProof
): Promise<Readonly<Record<string, string>>> {
  let command: string
  let params: Record<string, unknown>
  if (key === 'model') {
    const model = parsePiModelOptionId(value)
    modelSchema.parse({ provider: model.provider, id: model.modelId })
    command = 'set_model'
    params = model
  } else if (key === 'effort') {
    if (!PI_THINKING_LEVELS.some((level) => level === value)) {
      throw new Error(`Unsupported Pi thinking level: ${value}`)
    }
    command = 'set_thinking_level'
    params = { level: value }
  } else {
    throw new Error(`Unsupported Pi option: ${key}`)
  }
  options.signal?.throwIfAborted()
  const token = { pending: true }
  proof?.writes.set(key, token)
  proof?.current.delete(key)
  if (key === 'model') {
    proof?.writes.set('effort', token)
    proof?.current.delete('effort')
  }
  try {
    await waitForPromiseWithSignal(
      rpc.request(command, params, { timeoutMs: options.timeoutMs }),
      options.signal
    )
    if (proof && proof.writes.get(key) !== token) {
      throw new Error('Pi option write was superseded')
    }
    selected.set(key, value)
    proof?.current.set(key, value)
    return Object.fromEntries(selected)
  } finally {
    const settled = { pending: false }
    for (const [affected, write] of proof?.writes ?? []) {
      if (write === token) {
        proof?.writes.set(affected, settled)
      }
    }
  }
}

export async function readPiRpcCommands(rpc: PiRpcRequester): Promise<AgentSessionCommandsResult> {
  const { commands } = commandsSchema.parse(await rpc.request('get_commands'))
  return {
    commands: commands.map((command) => ({
      name: command.name,
      kind: command.source === 'skill' ? 'skill' : 'command',
      ...(command.source === undefined ? { kindUnspecified: true as const } : {}),
      ...(command.description ? { description: command.description } : {})
    }))
  }
}
