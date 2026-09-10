import type {
  AgentHealthCheck,
  AgentHealthCheckId,
  AgentHealthCheckStatus
} from '../../shared/agent-health'

const VERSION_PATTERN = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/
const CODEX_CHECK_IDS: Partial<Record<string, AgentHealthCheckId>> = {
  'auth.credentials': 'authentication',
  'network.provider_reachability': 'provider',
  'network.websocket_reachability': 'websocket'
}

type CodexDoctorCheck = {
  id: string
  status: unknown
  details: unknown
}

export type CodexDoctorReport = {
  checks: AgentHealthCheck[]
  latestVersion: string | null
}

function normalizedCheckStatus(value: unknown): AgentHealthCheckStatus | null {
  if (value === 'ok') {
    return 'ok'
  }
  if (value === 'warning') {
    return 'warning'
  }
  return value === 'fail' ? 'failed' : null
}

function normalizedDoctorChecks(value: unknown): CodexDoctorCheck[] | null {
  let entries: [string | null, unknown][]
  if (Array.isArray(value)) {
    entries = value.map((check) => [null, check])
  } else if (value && typeof value === 'object') {
    entries = Object.entries(value)
  } else {
    return null
  }
  return entries.flatMap(([fallbackId, check]) => {
    if (!check || typeof check !== 'object') {
      return []
    }
    const raw = check as Record<string, unknown>
    const id = typeof raw.id === 'string' ? raw.id : fallbackId
    return id ? [{ id, status: raw.status, details: raw.details }] : []
  })
}

export function parseCodexDoctorReport(output: string): CodexDoctorReport | null {
  try {
    const report = JSON.parse(output) as { checks?: unknown }
    const reportChecks = normalizedDoctorChecks(report.checks)
    if (!reportChecks) {
      return null
    }
    const checks = reportChecks.flatMap((check) => {
      const id = CODEX_CHECK_IDS[check.id]
      const status = normalizedCheckStatus(check.status)
      return id && status ? [{ id, status }] : []
    })
    const updateDetails = reportChecks.find((check) => check.id === 'updates.status')?.details
    const rawLatestVersion =
      updateDetails && typeof updateDetails === 'object' && 'latest version' in updateDetails
        ? updateDetails['latest version']
        : null
    const latestVersion =
      typeof rawLatestVersion === 'string'
        ? (rawLatestVersion.match(VERSION_PATTERN)?.[0] ?? null)
        : null
    return { checks, latestVersion }
  } catch {
    return null
  }
}

export function parseCodexDoctorChecks(output: string): AgentHealthCheck[] | null {
  return parseCodexDoctorReport(output)?.checks ?? null
}
