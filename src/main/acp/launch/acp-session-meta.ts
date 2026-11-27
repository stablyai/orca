import type { AcpLaunchSpec } from './acp-launch-contract'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function appendedPrompt(antigravity: Record<string, unknown>): string | undefined {
  const prompt = antigravity.systemPrompt
  return record(prompt) && typeof prompt.append === 'string' ? prompt.append : undefined
}

/** Later layers win, but Antigravity takes one appended prompt, so every layer's text is kept. */
export function acpSessionStartMeta(
  spec: Pick<AcpLaunchSpec, 'sessionMeta'>,
  ...layers: (Readonly<Record<string, unknown>> | undefined)[]
): { _meta?: Record<string, unknown> } {
  let meta: Record<string, unknown> = { ...spec.sessionMeta }
  for (const layer of layers) {
    const base = meta.antigravity
    const added = layer?.antigravity
    meta = { ...meta, ...layer }
    if (record(base) && record(added)) {
      const append = [appendedPrompt(base), appendedPrompt(added)].filter(Boolean).join('\n\n')
      meta.antigravity = { ...base, ...added, ...(append ? { systemPrompt: { append } } : {}) }
    }
  }
  return Object.keys(meta).length ? { _meta: meta } : {}
}
