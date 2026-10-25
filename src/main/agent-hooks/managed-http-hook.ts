import type { AgentHookSource } from '../../shared/agent-hook-relay'

// Command entries are recognized by their script name; http entries carry that name in the URL.
export const MANAGED_HTTP_HOOK_MARKER_PARAM = 'orca-hook'

const MANAGED_HTTP_HOOK_HOST = '127.0.0.1'

// Header values interpolate the pane env inside the agent process, so no shell runs per event.
const PANE_HEADER_ENV: readonly (readonly [header: string, env: string])[] = [
  ['X-Orca-Agent-Hook-Token', 'ORCA_AGENT_HOOK_TOKEN'],
  ['X-Orca-Pane-Key', 'ORCA_PANE_KEY'],
  ['X-Orca-Tab-Id', 'ORCA_TAB_ID'],
  ['X-Orca-Launch-Token', 'ORCA_AGENT_LAUNCH_TOKEN'],
  ['X-Orca-Agent-Hook-Env', 'ORCA_AGENT_HOOK_ENV'],
  ['X-Orca-Agent-Hook-Version', 'ORCA_AGENT_HOOK_VERSION']
]

/** The script's skip guards, sent as headers so the listener can apply them. */
export const MANAGED_HTTP_HOOK_GUARD_HEADER_ENV: readonly (readonly [
  header: string,
  env: string
])[] = [
  ['X-Orca-Claude-Job-Dir', 'CLAUDE_JOB_DIR'],
  ['X-Orca-Devin-Project-Dir', 'DEVIN_PROJECT_DIR'],
  ['X-Orca-Grok-Hook-Event', 'GROK_HOOK_EVENT'],
  ['X-Orca-Cursor-Version', 'CURSOR_VERSION'],
  ['X-Orca-Cursor-Project-Dir', 'CURSOR_PROJECT_DIR']
]

export type ManagedHttpHookConfig = {
  type: 'http'
  url: string
  timeout: number
  headers: Record<string, string>
  allowedEnvVars: string[]
}

export function buildManagedHttpHookUrl(
  port: number,
  source: AgentHookSource,
  scriptStem: string
): string {
  const marker = new URLSearchParams({ [MANAGED_HTTP_HOOK_MARKER_PARAM]: scriptStem })
  return `http://${MANAGED_HTTP_HOOK_HOST}:${port}/hook/${source}?${marker.toString()}`
}

/** The live listener a managed http entry posts to. */
export type ManagedHttpHookTarget = { port: number; source: AgentHookSource }

export function buildManagedHttpHook(
  target: ManagedHttpHookTarget,
  scriptStem: string,
  timeout: number
): ManagedHttpHookConfig {
  const headerEnv = [...PANE_HEADER_ENV, ...MANAGED_HTTP_HOOK_GUARD_HEADER_ENV]
  return {
    type: 'http',
    url: buildManagedHttpHookUrl(target.port, target.source, scriptStem),
    timeout,
    headers: Object.fromEntries(headerEnv.map(([header, env]) => [header, `\${${env}}`])),
    allowedEnvVars: headerEnv.map(([, env]) => env)
  }
}

/** True for an Orca http entry written for this script, on any port. */
export function isManagedHttpHookUrl(value: string, scriptStem: string): boolean {
  if (!value.startsWith(`http://${MANAGED_HTTP_HOOK_HOST}:`)) {
    return false
  }
  try {
    const url = new URL(value)
    // The prefix check reads the raw string; `http://127.0.0.1:@example.com/...` passes
    // it with 127.0.0.1 as the userinfo, so the parsed host has to match as well.
    return (
      url.hostname === MANAGED_HTTP_HOOK_HOST &&
      url.pathname.startsWith('/hook/') &&
      url.searchParams.get(MANAGED_HTTP_HOOK_MARKER_PARAM) === scriptStem
    )
  } catch {
    return false
  }
}

/** The listener's view: did a managed http entry, rather than a script, send this request? */
export function isManagedHttpHookRequest(requestUrl: string | undefined): boolean {
  if (!requestUrl) {
    return false
  }
  try {
    return new URL(requestUrl, `http://${MANAGED_HTTP_HOOK_HOST}`).searchParams.has(
      MANAGED_HTTP_HOOK_MARKER_PARAM
    )
  } catch {
    return false
  }
}
