import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'
import { RATE_LIMITED_STALE_THRESHOLD_MS } from './service/service-types'

/** 저장된 quota 창의 입력 형식이다. */
const windowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().positive(),
  resetsAt: z.number().nullable(),
  resetDescription: z.string().nullable()
})
/** 토큰·원본 응답·인증 메타데이터를 제외한 마지막 사용량만 저장한다. */
const snapshotSchema = z.object({
  provider: z.literal('claude'),
  session: windowSchema.nullable(),
  weekly: windowSchema.nullable(),
  fableWeekly: windowSchema.nullable().optional(),
  extraUsage: z
    .object({
      unit: z.literal('currency'),
      enabled: z.boolean(),
      disabledReason: z.string().nullable(),
      resetsAt: z.number().nullable(),
      balance: z.number().nullable(),
      currencyCode: z.string(),
      spent: z.number().nullable(),
      spendLimit: z.number().nullable(),
      spentPercent: z.number().nullable()
    })
    .nullable()
    .optional(),
  updatedAt: z.number().nonnegative(),
  error: z.null(),
  status: z.literal('ok')
})
/** 계정별 서버 대기와 표시 값을 함께 검증한다. */
const cacheSchema = z.record(
  z.string().regex(/^[a-f0-9]{64}$/),
  z.object({
    blockedUntil: z.number().nonnegative(),
    updatedAt: z.number().nonnegative(),
    snapshot: snapshotSchema.nullable()
  })
)
/** 현재 실행 호스트의 usage 캐시 소유자다. */
let cache: ClaudeUsageCache | null = null

/**
 * 프로필 폴더를 기준으로 모든 사용량 요청 경로의 서버 대기를 공유한다.
 * @param configDir 계정의 실제 인증 폴더
 * @param fetchUsage 대기가 끝났을 때 실행할 사용량 조회
 * @returns 마지막 사용량 또는 새 조회 결과
 */
export function fetchCachedClaudeUsage(
  configDir: string,
  fetchUsage: () => Promise<ProviderRateLimits>
): Promise<ProviderRateLimits> {
  const file = join(getCanonicalUserDataPath(), 'orca-claude-usage-cache.json')
  if (cache?.file !== file) {
    cache = new ClaudeUsageCache(file)
  }
  return cache.fetch(configDir, fetchUsage)
}

/** 같은 계정의 겹친 조회를 합치고 기존 usage writer로 대기를 내구성 있게 저장한다. */
class ClaudeUsageCache {
  private entries: Promise<z.infer<typeof cacheSchema>> | null = null
  private readonly pending = new Map<string, Promise<ProviderRateLimits>>()
  private writer: UsageCacheSnapshotWriter | null = null

  /** @param file 현재 호스트의 캐시 파일 */
  constructor(readonly file: string) {}

  /**
   * @param configDir 계정의 실제 인증 폴더
   * @param fetchUsage 모의 또는 실제 사용량 조회
   * @returns 서버 대기를 지킨 사용량 결과
   */
  fetch(
    configDir: string,
    fetchUsage: () => Promise<ProviderRateLimits>
  ): Promise<ProviderRateLimits> {
    // 폴더는 토큰 교체 후에도 같고, WSL·SSH 프로필은 각 호스트의 실제 경로로 분리된다.
    const key = createHash('sha256').update(resolve(configDir)).digest('hex')
    const existing = this.pending.get(key)
    if (existing) {
      return existing
    }
    const operation = this.readUsage(key, fetchUsage).finally(() => this.pending.delete(key))
    this.pending.set(key, operation)
    return operation
  }

  /**
   * @param key 인증 폴더의 비밀 값 없는 해시
   * @param fetchUsage 대기 만료 후 실행할 조회
   * @returns 원래 타임스탬프를 유지한 사용량 결과
   */
  private async readUsage(
    key: string,
    fetchUsage: () => Promise<ProviderRateLimits>
  ): Promise<ProviderRateLimits> {
    this.entries ??= readFile(this.file, 'utf8')
      .then(
        (raw) => cacheSchema.parse(JSON.parse(raw)),
        (error: unknown) => {
          if (isDefinitiveAbsence(error)) {
            return {}
          }
          throw error
        }
      )
      .catch((error: unknown) => {
        this.entries = null
        throw error
      })
    const entries = await this.entries
    const previous = entries[key]
    if (previous && previous.blockedUntil > Date.now()) {
      return {
        ...(previous.snapshot ?? {
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: previous.updatedAt
        }),
        status: 'error',
        error: 'Claude usage is rate limited right now.',
        usageMetadata: { failureKind: 'rate-limited', retryAtMs: previous.blockedUntil }
      }
    }
    const fresh = await fetchUsage()
    if (fresh.status !== 'ok' && fresh.usageMetadata?.failureKind !== 'rate-limited') {
      return fresh
    }
    const snapshot =
      fresh.status === 'ok' ? snapshotSchema.parse(fresh) : (previous?.snapshot ?? null)
    entries[key] = {
      blockedUntil: fresh.usageMetadata?.retryAtMs ?? 0,
      updatedAt: fresh.updatedAt,
      snapshot
    }
    for (const [entryKey, entry] of Object.entries(entries)) {
      if (
        entry.blockedUntil <= Date.now() &&
        Date.now() - entry.updatedAt > RATE_LIMITED_STALE_THRESHOLD_MS
      ) {
        delete entries[entryKey]
      }
    }
    this.writer ??= new UsageCacheSnapshotWriter('[claude-usage-cache]', () => this.file)
    // 저장 실패를 writer가 기록하며, 현재 프로세스의 서버 대기는 계속 유지한다.
    await this.writer.write(() => JSON.stringify(entries)).catch(() => {})
    await this.writer.flush()
    return fresh.status !== 'ok' && snapshot
      ? {
          ...snapshot,
          status: fresh.status,
          error: fresh.error,
          usageMetadata: fresh.usageMetadata
        }
      : fresh
  }
}
