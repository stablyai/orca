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
  currentVersion: string | null
  latestVersion: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function versionFromValue(value: unknown): string | null {
  return typeof value === 'string' ? (value.match(VERSION_PATTERN)?.[0] ?? null) : null
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
  } else if (isRecord(value)) {
    entries = Object.entries(value)
  } else {
    return null
  }
  return entries.flatMap(([fallbackId, check]) => {
    if (!isRecord(check)) {
      return []
    }
    const id = typeof check.id === 'string' ? check.id : fallbackId
    return id ? [{ id, status: check.status, details: check.details }] : []
  })
}

export function parseCodexDoctorReport(output: string): CodexDoctorReport | null {
  try {
    const report: unknown = JSON.parse(output)
    if (!isRecord(report)) {
      return null
    }
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
    const latestVersion = isRecord(updateDetails)
      ? versionFromValue(updateDetails['latest version'])
      : null
    return {
      checks,
      currentVersion: versionFromValue(report.codexVersion),
      latestVersion
    }
  } catch {
    return null
  }
}

export function parseCodexDoctorChecks(output: string): AgentHealthCheck[] | null {
  return parseCodexDoctorReport(output)?.checks ?? null
}
