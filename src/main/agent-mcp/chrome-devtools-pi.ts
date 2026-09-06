import { isAbsolute, join } from 'node:path'
import { isRecord, readConfig, type ConfigPlan } from './chrome-devtools-config'
import { parseJsoncConfig } from './chrome-devtools-jsonc'
import { planStdioJsonConfig } from './chrome-devtools-stdio-json'
import { verifyPiRuntime } from './chrome-devtools-pi-runtime'

export function planPiConfig(
  home: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): ConfigPlan {
  const agentDir =
    env.ORCA_PI_SOURCE_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(home, '.pi', 'agent')
  if (!isAbsolute(agentDir)) {
    throw new Error('Pi source agent directory must be absolute.')
  }
  const settingsPath = join(agentDir, 'settings.json')
  const settings = parseJsoncConfig(readConfig(settingsPath) ?? '{}', settingsPath, 'Pi')
  const packages = Array.isArray(settings.packages) ? settings.packages : []
  const registrations = packages.filter((entry) => {
    const source = typeof entry === 'string' ? entry : isRecord(entry) ? entry.source : undefined
    return typeof source === 'string' && /^npm:pi-mcp-adapter(?:@[^\s]+)?$/.test(source)
  })
  const registration = registrations[0]
  if (
    registrations.length !== 1 ||
    (isRecord(registration) &&
      (registration.autoload === false || registration.extensions !== undefined))
  ) {
    throw new Error(
      `Pi requires one enabled, unfiltered npm:pi-mcp-adapter package in ${settingsPath}. Install it through Pi first; custom extension layouts require manual setup.`
    )
  }
  const source = typeof registration === 'string' ? registration : String(registration.source)
  const prerequisite = verifyPiRuntime(agentDir, home, env, platform, source.split('@')[1])
  const configPath = join(agentDir, 'mcp.json')
  return {
    ...planStdioJsonConfig('pi', configPath, readConfig(configPath), platform),
    prerequisite
  }
}
