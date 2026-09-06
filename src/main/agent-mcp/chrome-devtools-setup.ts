import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname } from 'node:path'
import { writeFileAtomically, writeFileAtomicallyIfUnchanged } from '../codex-accounts/fs-utils'
import { planCodexConfig } from './chrome-devtools-codex'
import { planOpenCodeConfig } from './chrome-devtools-opencode'
import { planGeminiConfig } from './chrome-devtools-gemini'
import { planPiConfig } from './chrome-devtools-pi'
import { readConfig, type ConfigPlan } from './chrome-devtools-config'

export const CHROME_DEVTOOLS_TARGETS = ['codex', 'opencode', 'gemini', 'pi'] as const
export function isChromeDevtoolsTarget(value: unknown): value is ConfigPlan['agent'] | 'all' {
  return value === 'all' || CHROME_DEVTOOLS_TARGETS.some((target) => target === value)
}

export type ChromeDevtoolsOptions = {
  agent: ConfigPlan['agent'] | 'all'
  apply: boolean
  home?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export async function configureChromeDevtools(options: ChromeDevtoolsOptions) {
  const home = options.home ?? homedir()
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const plans: ConfigPlan[] = []
  const targets = options.agent === 'all' ? CHROME_DEVTOOLS_TARGETS : [options.agent]
  for (const agent of targets) {
    if (agent === 'codex') {
      plans.push(await planCodexConfig(home, env, platform))
    }
    if (agent === 'opencode') {
      plans.push(planOpenCodeConfig(home, env, platform))
    }
    if (agent === 'gemini') {
      plans.push(planGeminiConfig(home, env, platform))
    }
    if (agent === 'pi') {
      plans.push(planPiConfig(home, env, platform))
    }
  }
  const results = plans.map((plan) => ({
    agent: plan.agent,
    configPath: plan.configPath,
    state: plan.before === plan.after ? 'configured' : 'missing',
    backupPath: null as string | null,
    prerequisite: plan.prerequisite
  }))
  if (options.apply) {
    for (const plan of plans) {
      if (readConfig(plan.configPath) !== plan.before) {
        throw new Error(
          `Config changed during validation: ${plan.configPath}. Retry after the other writer finishes.`
        )
      }
    }
    const applied: string[] = []
    try {
      for (const [index, plan] of plans.entries()) {
        if (plan.before === plan.after) {
          continue
        }
        mkdirSync(dirname(plan.configPath), { recursive: true })
        if (plan.before !== null) {
          const backupPath = `${plan.configPath}.orca-chrome-devtools-${randomUUID()}.bak`
          writeFileAtomically(backupPath, plan.before, { mode: 0o600, repairPermissions: false })
          results[index].backupPath = backupPath
        }
        if (
          !writeFileAtomicallyIfUnchanged(plan.configPath, plan.before, plan.after, {
            mode: 0o600,
            repairPermissions: false
          })
        ) {
          throw new Error(`Config changed during installation: ${plan.configPath}.`)
        }
        applied.push(plan.configPath)
        results[index].state = 'configured'
      }
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Applied files: ${applied.join(', ') || 'none'}. Existing-file backups use the .orca-chrome-devtools-*.bak suffix.`,
        { cause: error }
      )
    }
  }
  return {
    executionHost: hostname(),
    platform,
    applied: options.apply,
    configs: results,
    mcpHandshake: 'not-checked',
    browserConnection: 'not-checked',
    nextStep:
      'Enable remote debugging in Chrome 144+ at chrome://inspect/#remote-debugging, restart the agent session, and allow Chrome’s connection prompt.',
    scope:
      'Global configuration on this execution host. Project, system, extension, and managed overlay settings can override it; autoConnect requires Chrome on the same host.'
  }
}
