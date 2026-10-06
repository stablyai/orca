import { z } from 'zod'

const launchConfig = z
  .object({ agents: z.record(z.string(), z.record(z.string(), z.unknown())).optional() })
  .passthrough()

export function resolveOpenCodeLaunchModelConfig(options: {
  configContent: string | undefined
  primaryAgent: string
  model: string
}): string | null {
  if (!options.primaryAgent || !options.model || (options.configContent?.length ?? 0) > 1_048_576) {
    return null
  }
  try {
    const raw: unknown = options.configContent?.trim() ? JSON.parse(options.configContent) : {}
    const parsed = launchConfig.safeParse(raw)
    if (!parsed.success) {
      return null
    }
    const config = parsed.data
    return JSON.stringify({
      ...config,
      model: options.model,
      agents: {
        ...config.agents,
        [options.primaryAgent]: { ...config.agents?.[options.primaryAgent], model: options.model }
      }
    })
  } catch {
    return null
  }
}
