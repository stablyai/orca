import { writeSync } from 'node:fs'
import { serviceTierFamily } from '@oh-my-pi/pi-ai'
import {
  SERVICE_TIER_OPENAI_OPTIONS,
  SERVICE_TIER_ANTHROPIC_OPTIONS,
  SERVICE_TIER_GOOGLE_OPTIONS
} from '@oh-my-pi/pi-coding-agent/config/service-tier'

export default function orcaNativeChat(api) {
  if (!process.argv.includes('acp')) {
    return
  }

  const root = (ctx) => ctx.agent?.kind === 'main'
  // OMP redirects process.stdout.write to stderr in ACP; protocol frames use the actual stdout fd.
  const notify = (method, params) =>
    writeSync(1, `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  const choices = {
    openai: SERVICE_TIER_OPENAI_OPTIONS,
    anthropic: SERVICE_TIER_ANTHROPIC_OPTIONS,
    google: SERVICE_TIER_GOOGLE_OPTIONS
  }
  const reportOptions = (ctx) => {
    if (!root(ctx) || typeof api.getServiceTiers !== 'function') {
      return
    }
    const tiers = api.getServiceTiers()
    notify('_orca/omp/options', {
      models: ctx.modelRegistry.getAvailable().map((model) => {
        const family = serviceTierFamily(model)
        return {
          id: `${model.provider}/${model.id}`,
          serviceTiers: choices[family] ?? [],
          serviceTier: family ? (tiers[family] ?? 'none') : null
        }
      })
    })
  }

  api.on('session_start', (_event, ctx) => reportOptions(ctx))
  api.on('session_switch', (_event, ctx) => reportOptions(ctx))
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
      if (!choices[family]?.some((choice) => choice.value === tier)) {
        throw new Error('This model has no matching native service tier')
      }
      api.setServiceTier(family, tier === 'none' ? undefined : tier)
      reportOptions(ctx)
    }
  })

  let outputTokens = 0
  let durationMs = 0
  let measured = true
  let requestStartedAt
  api.on('agent_start', (_event, ctx) => {
    if (!root(ctx)) {
      return
    }
    outputTokens = 0
    durationMs = 0
    measured = true
    requestStartedAt = undefined
  })
  api.on('before_provider_request', (_event, ctx) => {
    if (root(ctx)) {
      requestStartedAt = performance.now()
    }
  })
  api.on('message_end', ({ message }, ctx) => {
    if (!root(ctx) || message.role !== 'assistant') {
      return
    }
    const tokens = message.usage?.output
    const elapsed =
      requestStartedAt === undefined ? undefined : performance.now() - requestStartedAt
    requestStartedAt = undefined
    const duration = message.duration ?? elapsed
    // Synthetic assistant notices have no provider request or output to measure.
    if (tokens === 0 && duration === undefined) {
      return
    }
    measured &&= Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(duration) && duration > 0
    if (!measured) {
      return
    }
    outputTokens += tokens
    durationMs += duration
    if (outputTokens > 0 && durationMs > 0) {
      // Native agent_end hooks can run after ACP has already returned the prompt result.
      notify('_orca/omp/generation', { outputTokens, durationMs })
    }
  })
  api.on('agent_end', (_event, ctx) => reportOptions(ctx))
}
