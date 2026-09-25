import { requestAntigravityLocalQuota } from './antigravity-local-quota-request'
import { z } from 'zod'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { readWindowsProcessTable } from '../windows/windows-process-table'
import { runPortScanCommand } from '../ports/port-scan-command-client'
import { scanPlatformListeningPorts } from '../ports/local-workspace-platform-port-scanner'

const QUOTA_SUMMARY_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const USER_STATUS_PATH = '/exa.language_server_pb.LanguageServerService/GetUserStatus'

const quotaBucketSchema = z.object({
  bucketId: z.string().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  window: z.string().optional(),
  remainingFraction: z.number().finite().optional(),
  disabled: z.boolean().optional(),
  resetTime: z.string().optional()
})

const quotaGroupSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  buckets: z.array(quotaBucketSchema).optional()
})

const quotaSummarySchema = z.object({
  response: z
    .object({
      groups: z.array(quotaGroupSchema).optional(),
      description: z.string().optional()
    })
    .optional(),
  groups: z.array(quotaGroupSchema).optional()
})

const userStatusSchema = z.object({
  userStatus: z
    .object({
      planStatus: z
        .object({
          planInfo: z
            .object({
              planName: z.string().optional()
            })
            .optional()
        })
        .optional()
    })
    .optional(),
  planName: z.string().optional()
})

export type ParsedAntigravityQuota = {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}

function isFiveHourBucket(b: z.infer<typeof quotaBucketSchema>): boolean {
  const windowStr = (b.window || '').toLowerCase()
  const nameStr = `${b.displayName || ''} ${b.bucketId || ''}`.toLowerCase()
  return (
    windowStr === '5h' ||
    windowStr === '300' ||
    nameStr.includes('5h') ||
    nameStr.includes('five hour') ||
    nameStr.includes('5 hour')
  )
}

function isWeeklyBucket(b: z.infer<typeof quotaBucketSchema>): boolean {
  const windowStr = (b.window || '').toLowerCase()
  const nameStr = `${b.displayName || ''} ${b.bucketId || ''}`.toLowerCase()
  return (
    windowStr === 'weekly' ||
    windowStr === '10080' ||
    nameStr.includes('weekly') ||
    nameStr.includes('week')
  )
}

export function parseAntigravityQuotaSummary(raw: unknown): ParsedAntigravityQuota {
  const parsed = quotaSummarySchema.safeParse(raw)
  if (!parsed.success) {
    return { session: null, weekly: null }
  }
  const groups = parsed.data.response?.groups ?? parsed.data.groups ?? []
  let session: RateLimitWindow | null = null
  let weekly: RateLimitWindow | null = null

  for (const group of groups) {
    for (const b of group.buckets ?? []) {
      if (
        b.disabled ||
        b.remainingFraction === undefined ||
        b.remainingFraction < 0 ||
        b.remainingFraction > 1
      ) {
        continue
      }
      const usedPercent = Math.round((1 - b.remainingFraction) * 100)
      const resetsAt = b.resetTime ? new Date(b.resetTime).getTime() : null
      const validResetsAt = resetsAt && !Number.isNaN(resetsAt) ? resetsAt : null

      if (isFiveHourBucket(b)) {
        const item: RateLimitWindow = {
          usedPercent,
          windowMinutes: 300,
          resetsAt: validResetsAt,
          resetDescription: null
        }
        if (!session || item.usedPercent > session.usedPercent) {
          session = item
        }
      } else if (isWeeklyBucket(b)) {
        const item: RateLimitWindow = {
          usedPercent,
          windowMinutes: 10080,
          resetsAt: validResetsAt,
          resetDescription: null
        }
        if (!weekly || item.usedPercent > weekly.usedPercent) {
          weekly = item
        }
      }
    }
  }

  return { session, weekly }
}

export function parseAntigravityUserPlan(raw: unknown): string | null {
  const parsed = userStatusSchema.safeParse(raw)
  if (!parsed.success) {
    return null
  }
  return parsed.data.userStatus?.planStatus?.planInfo?.planName ?? parsed.data.planName ?? null
}

type LocalServerTarget = {
  pid: number
  csrfToken: string
}

export function selectAntigravityLocalServer(
  rows: { pid: number; command: string }[]
): LocalServerTarget | null {
  const candidates: LocalServerTarget[] = []
  for (const row of rows) {
    // Only a language server executable inside an Antigravity installation is eligible.
    const executable = row.command.match(/^(?:"([^"]+)"|([^\s]+))/)
    const executablePath = executable?.[1] ?? executable?.[2] ?? ''
    if (
      !/[\\/](?:\.?antigravity(?:-cli)?|agy)[\\/]/i.test(executablePath) ||
      !/[\\/]language_server[^\\/]*$/i.test(executablePath) ||
      !Number.isSafeInteger(row.pid) ||
      row.pid <= 0
    ) {
      continue
    }
    const token = row.command.match(/--csrf_token(?:=|\s+)(?:"([^"\r\n]+)"|([^\s"]+))/)
    const csrfToken = token?.[1] ?? token?.[2]
    if (csrfToken) {
      candidates.push({ pid: row.pid, csrfToken })
    }
  }
  // Multiple instances cannot be attributed to the current account safely.
  return candidates.length === 1 ? candidates[0] : null
}

async function findLocalLanguageServerProcess(): Promise<LocalServerTarget | null> {
  if (process.platform === 'win32') {
    return selectAntigravityLocalServer(await readWindowsProcessTable().catch(() => []))
  }
  try {
    const { stdout } = await runPortScanCommand('ps', ['-ax', '-o', 'pid,command'])
    const rows = stdout.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.+)$/)
      return match ? [{ pid: Number(match[1]), command: match[2] }] : []
    })
    return selectAntigravityLocalServer(rows)
  } catch {
    return null
  }
}

async function findListeningPortsForPid(pid: number): Promise<number[]> {
  try {
    // Reuse the host scanner's PID/inode ownership checks, including Linux /proc fd lookup.
    const { ports } = await scanPlatformListeningPorts({})
    return [
      ...new Set(
        ports
          .filter(
            (p) => p.pid === pid && p.port > 0 && (p.host === '127.0.0.1' || p.host === '0.0.0.0')
          )
          .map((p) => p.port)
      )
    ]
  } catch {
    return []
  }
}

export type AntigravityProbeDependencies = {
  findProcess?: () => Promise<LocalServerTarget | null>
  findPorts?: (pid: number) => Promise<number[]>
  requestJson?: (options: {
    port: number
    path: string
    csrfToken: string
    isHttps: boolean
    signal?: AbortSignal
  }) => Promise<{ status: number; body: unknown }>
}

export async function probeLocalAntigravityLanguageServer(
  options: {
    signal?: AbortSignal
    deps?: AntigravityProbeDependencies
  } = {}
): Promise<ProviderRateLimits | null> {
  const deps = options.deps ?? {}
  const findProcess = deps.findProcess ?? findLocalLanguageServerProcess
  const findPorts = deps.findPorts ?? findListeningPortsForPid
  const requester = deps.requestJson ?? requestAntigravityLocalQuota

  if (options.signal?.aborted) {
    return null
  }
  const target = await findProcess().catch(() => null)
  if (!target || options.signal?.aborted) {
    return null
  }

  const ports = await findPorts(target.pid).catch(() => [])
  if (ports.length === 0) {
    return null
  }

  for (const port of ports) {
    for (const isHttps of [false, true]) {
      if (options.signal?.aborted) {
        return null
      }
      try {
        const quotaRes = await requester({
          port,
          path: QUOTA_SUMMARY_PATH,
          csrfToken: target.csrfToken,
          isHttps,
          signal: options.signal
        })

        if (options.signal?.aborted) {
          return null
        }
        if (quotaRes.status === 200 && quotaRes.body) {
          const quota = parseAntigravityQuotaSummary(quotaRes.body)
          if (quota.session || quota.weekly) {
            let planType: string | null = null
            try {
              const statusRes = await requester({
                port,
                path: USER_STATUS_PATH,
                csrfToken: target.csrfToken,
                isHttps,
                signal: options.signal
              })
              if (statusRes.status === 200) {
                planType = parseAntigravityUserPlan(statusRes.body)
              }
            } catch {
              // Plan extraction optional
            }

            if (options.signal?.aborted) {
              return null
            }
            return {
              provider: 'antigravity',
              session: quota.session,
              weekly: quota.weekly,
              planType,
              updatedAt: Date.now(),
              error: null,
              status: 'ok',
              buckets: undefined
            }
          }
        }
      } catch {
        // Try next port or protocol
      }
    }
  }

  return null
}
