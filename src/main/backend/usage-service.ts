import { z } from 'zod'
import { ClaudeUsageStore } from '../claude-usage/store'
import { CodexUsageStore } from '../codex-usage/store'
import { OpenCodeUsageStore } from '../opencode-usage/store'
import { MuseUsageStore } from '../muse-usage/store'
import type { UsageStoreHost } from '../usage/usage-store-host'
import { stopUsageScanWorker } from '../usage/scan-worker/usage-scan-worker-spawn'
import type { UsageProviderKey } from '../../shared/backend-service-contract'

const rangeSchema = z.object({
  scope: z.string().max(4096),
  range: z.string().max(128),
  limit: z.number().int().nonnegative().optional()
})
const automationSchema = z.object({
  worktreeId: z.string().nullable(),
  terminalSessionId: z.string().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable()
})
type Handler = (params: unknown) => unknown

type QueryStore<Scope, Range, Kind> = {
  whenLoaded(): Promise<void>
  getScanState(): unknown
  setEnabled(enabled: boolean): unknown
  refresh(force?: boolean): unknown
  getSnapshot(scope: Scope, range: Range, limit?: number): unknown
  getSummary(scope: Scope, range: Range): unknown
  getDaily(scope: Scope, range: Range): unknown
  getBreakdown(scope: Scope, range: Range, kind: Kind): unknown
  getRecentSessions(scope: Scope, range: Range, limit?: number): unknown
}

function registerUsageQueries<Scope extends string, Range extends string, Kind extends string>(
  handlers: Map<string, Handler>,
  prefix: UsageProviderKey,
  store: QueryStore<Scope, Range, Kind>
): void {
  const query =
    (fn: (scope: Scope, range: Range, limit?: number) => unknown): Handler =>
    (raw) => {
      const args = rangeSchema.parse(raw)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each registered provider uses the same public scope/range contract; the generic preserves its query signature.
      return fn(args.scope as Scope, args.range as Range, args.limit)
    }
  handlers.set(`${prefix}:getScanState`, () => store.getScanState())
  handlers.set(`${prefix}:setEnabled`, (raw) =>
    store.setEnabled(z.object({ enabled: z.boolean() }).parse(raw).enabled)
  )
  handlers.set(`${prefix}:refresh`, (raw) =>
    store.refresh(z.object({ force: z.boolean().optional() }).optional().parse(raw)?.force ?? false)
  )
  handlers.set(
    `${prefix}:getSnapshot`,
    query((scope, range, limit) => store.getSnapshot(scope, range, limit))
  )
  handlers.set(
    `${prefix}:getSummary`,
    query((scope, range) => store.getSummary(scope, range))
  )
  handlers.set(
    `${prefix}:getDaily`,
    query((scope, range) => store.getDaily(scope, range))
  )
  handlers.set(
    `${prefix}:getRecentSessions`,
    query((scope, range, limit) => store.getRecentSessions(scope, range, limit))
  )
  handlers.set(`${prefix}:getBreakdown`, (raw) => {
    const args = rangeSchema.extend({ kind: z.string().max(128) }).parse(raw)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These are the provider API arguments shared by all four registered query stores.
    return store.getBreakdown(args.scope as Scope, args.range as Range, args.kind as Kind)
  })
}

export function createUsageService(host: UsageStoreHost) {
  const stores = {
    claudeUsage: new ClaudeUsageStore(host),
    codexUsage: new CodexUsageStore(host),
    openCodeUsage: new OpenCodeUsageStore(host),
    museUsage: new MuseUsageStore(host)
  }
  const all = Object.values(stores)
  const handlers = new Map<string, Handler>()
  registerUsageQueries(handlers, 'claudeUsage', stores.claudeUsage)
  registerUsageQueries(handlers, 'codexUsage', stores.codexUsage)
  registerUsageQueries(handlers, 'openCodeUsage', stores.openCodeUsage)
  registerUsageQueries(handlers, 'museUsage', stores.museUsage)
  let accepting = true
  const active = new Set<Promise<unknown>>()
  const stop = async (): Promise<void> => {
    accepting = false
    for (const store of all) {
      store.stopScanAdmission()
    }
    await ready
    await stopUsageScanWorker()
    await Promise.allSettled(active)
    await Promise.all(all.map((store) => store.settleScansForShutdown()))
    await Promise.all(all.map((store) => store.flush()))
  }
  const ready = Promise.all(all.map((store) => store.whenLoaded())).then(() => {})
  const dispatch = async (
    method: string,
    params: unknown,
    privileged: boolean
  ): Promise<unknown> => {
    if (!accepting) {
      throw new Error('Usage service is stopping. Try again after Orca reconnects.')
    }
    if (privileged && method === 'claudeUsage:getAutomationRunUsage') {
      return stores.claudeUsage.getAutomationRunUsage(automationSchema.parse(params))
    }
    if (privileged && method === 'codexUsage:getAutomationRunUsage') {
      return stores.codexUsage.getAutomationRunUsage(automationSchema.parse(params))
    }
    const handler = handlers.get(method)
    if (!handler) {
      throw new Error('This usage operation is not supported.')
    }
    return handler(params)
  }
  return {
    ready,
    invoke(
      method: string,
      params: unknown,
      privileged: boolean,
      signal?: AbortSignal
    ): Promise<unknown> {
      const operation = ready.then(() => {
        signal?.throwIfAborted()
        return dispatch(method, params, privileged)
      })
      active.add(operation)
      void operation.finally(() => active.delete(operation)).catch(() => {})
      return operation
    },
    stop
  }
}
