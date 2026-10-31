import { z } from 'zod'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { PiRpcRequester } from '../pi/rpc-options'

const stateSchema = z.object({
  model: z
    .object({
      provider: z.string(),
      id: z.string(),
      api: z.string().optional(),
      identity: z.object({ class: z.string() }).optional(),
      serviceTiers: z.array(z.string()).optional()
    })
    .nullish(),
  fastModeEnabled: z.boolean().optional(),
  fastModeActive: z.boolean().optional()
})

// OMP model-controls.setFastMode accepts priority only for its native service-tier families.
function supportsFastMode(model: NonNullable<z.infer<typeof stateSchema>['model']>): boolean {
  const openaiApi = ['openai-completions', 'openai-responses', 'openai-codex-responses'].includes(
    model.api ?? ''
  )
  const openai =
    ['openai', 'openai-codex'].includes(model.provider) ||
    (!['fireworks', 'github-copilot'].includes(model.provider) &&
      openaiApi &&
      model.identity?.class === 'openai')
  if (openai) {
    return (
      model.api !== 'openai-codex-responses' ||
      !model.serviceTiers?.length ||
      model.serviceTiers.includes('priority')
    )
  }
  return (
    model.api === 'anthropic-messages' ||
    ['google', 'google-vertex'].includes(model.provider) ||
    (model.provider === 'openrouter' &&
      ['openai', 'anthropic', 'gemini'].includes(model.identity?.class ?? ''))
  )
}

export async function readOmpFastOptions(
  rpc: PiRpcRequester,
  options: AgentSessionOptionsResult
): Promise<AgentSessionOptionsResult> {
  return projectOmpFastOptions(await rpc.request('get_state'), options)
}

export class OmpRpcFastOptions {
  private state: z.infer<typeof stateSchema> | undefined
  private revision = 0
  private stateRead = 0
  private pendingWrites = 0

  async request(
    rpc: PiRpcRequester,
    ...[command, params, options]: Parameters<PiRpcRequester['request']>
  ): Promise<unknown> {
    const write = command === 'set_fast_mode' || command === 'set_model'
    const revision = write ? ++this.revision : this.revision
    const read = command === 'get_state' ? ++this.stateRead : 0
    if (write) {
      this.pendingWrites++
    }
    try {
      const answer = await rpc.request(command, params, options)
      if (
        command === 'get_state' &&
        !this.pendingWrites &&
        revision === this.revision &&
        read === this.stateRead
      ) {
        this.state = stateSchema.safeParse(answer).data
      } else if (command === 'set_fast_mode') {
        const result = z.object({ enabled: z.boolean(), active: z.boolean() }).safeParse(answer)
        const previous = stateSchema.safeParse(this.state)
        this.state =
          revision === this.revision && result.success && previous.success
            ? {
                ...previous.data,
                fastModeEnabled: result.data.enabled,
                fastModeActive: result.data.active
              }
            : undefined
      } else if (command === 'set_model') {
        this.state = undefined
      }
      return answer
    } finally {
      if (write) {
        this.pendingWrites--
        this.revision++
      }
    }
  }

  read(options: AgentSessionOptionsResult): AgentSessionOptionsResult {
    return this.pendingWrites ? options : projectOmpFastOptions(this.state, options)
  }
}

function projectOmpFastOptions(
  value: unknown,
  options: AgentSessionOptionsResult
): AgentSessionOptionsResult {
  const parsed = stateSchema.safeParse(value)
  if (!parsed.success) {
    return options
  }
  const state = parsed.data
  if (!state.model || state.fastModeEnabled === undefined || state.fastModeActive === undefined) {
    return options
  }
  const supported = supportsFastMode(state.model)
  const id = `${state.model.provider}/${state.model.id}`
  if (options.current.model !== id) {
    return options
  }
  return {
    ...options,
    fastModeSupport: { supported, ...(!supported ? { reason: 'model-not-supported' } : {}) },
    models: options.models.map((model) => ({
      ...model,
      ...(model.id === id ? { supportsFastMode: supported } : {})
    })),
    current: {
      ...options.current,
      fastMode: state.fastModeEnabled,
      fastModeState: state.fastModeActive ? 'on' : 'off',
      confirmed: [...(options.current.confirmed ?? []), 'fastMode']
    }
  }
}
