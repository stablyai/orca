// Env admission policy: which user-configured agent env a launch may carry, and
// the client identity that decides it. Custom launches expose definition.env
// only when the initiating client is trusted (desktop/cli/host) or the agent
// opted into paired-device env sync; built-in launches keep their existing
// per-agent default env; safe-fallback launches carry no env at all.

import type { LaunchIntent } from '../../shared/agent-launch-host-contract'

export type LaunchClientKind = 'desktop' | 'paired-web' | 'mobile' | 'cli' | 'host-service'

export function clientOfIntent(intent: LaunchIntent): LaunchClientKind {
  if (intent.kind === 'interactive' || intent.kind === 'resume') {
    return intent.client
  }
  if (intent.kind === 'cli') {
    return 'cli'
  }
  return 'host-service'
}

export type EnvAdmission = {
  env: Record<string, string>
  policy: 'full' | 'withheld' | 'none'
  withheld: boolean
}

function emptyEnv(): Record<string, string> {
  return Object.create(null) as Record<string, string>
}

function copyEnv(source: Readonly<Record<string, string>>): Record<string, string> {
  const target = emptyEnv()
  for (const key of Object.keys(source)) {
    target[key] = source[key]
  }
  return target
}

/** Admit a custom agent's env per the initiating client. A paired/mobile client
 *  must have `syncEnv` to receive values; otherwise they are withheld (not
 *  dropped silently) and a notice is surfaced. Empty env resolves to 'none'. */
export function admitCustomEnv(
  configuredEnv: Readonly<Record<string, string>>,
  client: LaunchClientKind,
  syncEnv: boolean
): EnvAdmission {
  const hasEntries = Object.keys(configuredEnv).length > 0
  const trusted = client !== 'paired-web' && client !== 'mobile'
  if (!trusted && !syncEnv) {
    return { env: emptyEnv(), policy: hasEntries ? 'withheld' : 'none', withheld: hasEntries }
  }
  if (!hasEntries) {
    return { env: emptyEnv(), policy: 'none', withheld: false }
  }
  return { env: copyEnv(configuredEnv), policy: 'full', withheld: false }
}

const ORCA_ENV_KEY_PREFIX = /^orca_/i

/** Drop any `orca_*` key (case-insensitively). Built-in default env comes from a
 *  hand-editable `settings.agentDefaultEnv` that skips the custom-agent write-time
 *  validation, so without this it could smuggle Orca-generated attribution/hook/
 *  teams keys into a launch and spoof pane/hook identity. */
function stripOrcaEnvKeys(env: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    if (ORCA_ENV_KEY_PREFIX.test(key)) {
      continue
    }
    out[key] = env[key]
  }
  return out
}

/** Built-in launches keep their existing per-agent default env (yolo/env
 *  defaults), always full — the paired-sync gate is a custom-agent concept. */
export function admitBuiltInEnv(configuredEnv: Readonly<Record<string, string>>): EnvAdmission {
  const filtered = stripOrcaEnvKeys(configuredEnv)
  const hasEntries = Object.keys(filtered).length > 0
  return {
    env: hasEntries ? copyEnv(filtered) : emptyEnv(),
    policy: hasEntries ? 'full' : 'none',
    withheld: false
  }
}
