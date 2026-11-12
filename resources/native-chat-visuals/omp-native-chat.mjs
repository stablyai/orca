import { writeSync } from 'node:fs'
import { realizesPriorityServiceTier, serviceTierFamily } from '@oh-my-pi/pi-ai'

export default function orcaNativeChat(api) {
  if (!process.argv.includes('acp')) {
    return
  }

  const root = (ctx) => ctx.agent?.kind === 'main'
  // OMP redirects process.stdout.write to stderr in ACP; protocol frames use the actual stdout fd.
  const notify = (method, params) =>
    writeSync(1, `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  const supportsPriority = (model) =>
    Boolean(serviceTierFamily(model) && realizesPriorityServiceTier('priority', model))
  const reportOptions = (ctx) => {
    if (!root(ctx) || typeof api.getServiceTiers !== 'function') {
      return
    }
    const model = ctx.model
    const family = model && serviceTierFamily(model)
    notify('_orca/omp/options', {
      model: model ? `${model.provider}/${model.id}` : null,
      models: ctx.modelRegistry.getAvailable().map((entry) => ({
        id: `${entry.provider}/${entry.id}`,
        priority: supportsPriority(entry),
        family: serviceTierFamily(entry) ?? null
      })),
      serviceTier: family ? (api.getServiceTiers()[family] ?? 'default') : null
    })
  }

  api.on('session_start', (_event, ctx) => reportOptions(ctx))
  api.on('before_agent_start', (_event, ctx) => reportOptions(ctx))
  api.registerCommand('orca-service-tier', {
    description: 'Set the service tier selected in Orca',
    handler: (value, ctx) => {
      if (!root(ctx)) {
        return
      }
      const tier = value.trim()
      const model = ctx.model
      const family = model && serviceTierFamily(model)
      if (!family || !['default', 'priority'].includes(tier)) {
        throw new Error('This model has no supported Orca service tier')
      }
      if (tier === 'priority' && !supportsPriority(model)) {
        throw new Error('Priority service is unavailable for this model')
      }
      api.setServiceTier(family, tier === 'priority' ? 'priority' : undefined)
      reportOptions(ctx)
    }
  })

  let outputTokens = 0
  let durationMs = 0
  let measured = true
  api.on('agent_start', (_event, ctx) => {
    if (!root(ctx)) {
      return
    }
    outputTokens = 0
    durationMs = 0
    measured = true
  })
  api.on('message_end', ({ message }, ctx) => {
    if (!root(ctx) || message.role !== 'assistant') {
      return
    }
    const tokens = message.usage?.output
    const duration = message.duration
    measured &&= Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(duration) && duration > 0
    if (!measured) {
      return
    }
    outputTokens += tokens
    durationMs += duration
  })
  api.on('agent_end', (event, ctx) => {
    reportOptions(ctx)
    if (!root(ctx) || event.willContinue || !measured || outputTokens <= 0 || durationMs <= 0) {
      return
    }
    notify('_orca/omp/generation', { outputTokens, durationMs })
  })
}
