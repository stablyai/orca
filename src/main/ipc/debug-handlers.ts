import { resolve } from 'node:path'
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type {
  DebugBreakpointFields,
  DebugEvaluateContext,
  DebugLaunchTarget,
  DebugRefusal,
  DebugResult,
  DebugWorktree
} from '../../preload/api/debug-api'
import { listRepoWorktreeGraph } from '../repo-worktrees'
import { debugService, DebugServiceError, type DebugService } from '../debug/debug-service'
import type { DebugTrustDeps, HumanConfirmation } from '../debug/debug-service-trust'
import { isTrustedUIRenderer } from './ui'

type DebugHandlerStore = Pick<Store, 'getSettings' | 'getRepo' | 'updateSettings'>

export type DebugHandlerDeps = Partial<Pick<DebugTrustDeps, 'resolveAdapter' | 'platform'>> & {
  service?: DebugService
  /** Every worktree/folder root of the repo; a session root is derived from these, never from the renderer. */
  listRepoRoots?: (repo: Repo) => Promise<string[]>
  userDataPath?: string
}

type Params = Record<string, unknown>

export const DEBUG_UNTRUSTED_RENDERER: DebugRefusal = {
  ok: false,
  reason: 'untrusted-renderer',
  message: 'Only Orca’s own window may drive the debugger.'
}
// Module-private: only an approveLaunch that came through Orca's own window carries a confirmation.
const HUMAN = Symbol('debug human confirmation')
const humanConfirmation = (): HumanConfirmation => ({ [HUMAN]: true })

const EVALUATE_CONTEXTS: readonly string[] = ['watch', 'repl', 'hover', 'clipboard', 'variables']
const isEvaluateContext = (value: string): value is DebugEvaluateContext =>
  EVALUATE_CONTEXTS.includes(value)

async function listRootsOf(repo: Repo): Promise<string[]> {
  const worktrees = await listRepoWorktreeGraph(repo).catch(() => [])
  return [resolve(repo.path), ...worktrees.map((worktree) => resolve(worktree.path))]
}

const invalid = (key: string): DebugServiceError =>
  new DebugServiceError('request-failed', `invalid ${key}`)

function record(value: unknown): Params {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('params')
  }
  return Object.fromEntries(Object.entries(value))
}

function text(p: Params, key: string): string {
  const value = p[key]
  if (typeof value !== 'string' || value === '') {
    throw invalid(key)
  }
  return value
}

function int(p: Params, key: string): number {
  const value = p[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalid(key)
  }
  return value
}

const optText = (p: Params, key: string): string | undefined =>
  p[key] === undefined ? undefined : text(p, key)
const optInt = (p: Params, key: string): number | undefined =>
  p[key] === undefined ? undefined : int(p, key)
const worktree = (p: Params): string => text(p, 'worktreePath')
const target = (p: Params): DebugWorktree => ({
  repoId: text(p, 'repoId'),
  worktreePath: worktree(p)
})

function launchTarget(p: Params): DebugLaunchTarget {
  return {
    repoId: text(p, 'repoId'),
    worktreePath: worktree(p),
    configName: optText(p, 'configName'),
    filePath: optText(p, 'filePath'),
    lineNumber: optInt(p, 'lineNumber'),
    languageId: optText(p, 'languageId')
  }
}

function breakpointFields(value: unknown): DebugBreakpointFields {
  const p = record(value)
  const line = optInt(p, 'line')
  if (line !== undefined && line < 1) {
    throw invalid('line')
  }
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') {
    throw invalid('enabled')
  }
  const fields: DebugBreakpointFields = { line, column: optInt(p, 'column'), enabled: p.enabled }
  for (const key of ['condition', 'hitCondition', 'logMessage'] as const) {
    const field = p[key]
    if (field !== undefined && typeof field !== 'string') {
      throw invalid(key)
    }
    // An empty string is kept: it clears the field on update.
    fields[key] = field
  }
  return fields
}

function stringList(p: Params, key: string): string[] {
  const value = p[key]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalid(key)
  }
  return value
}

function toRefusal(error: unknown): DebugRefusal {
  if (error instanceof DebugServiceError) {
    return { ok: false, reason: error.reason, message: error.message }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, reason: 'request-failed', message }
}

export function registerDebugHandlers(store: DebugHandlerStore, deps: DebugHandlerDeps = {}): void {
  const service = deps.service ?? debugService
  service.configure({
    getSettings: () => store.getSettings(),
    getRepo: (repoId) => store.getRepo(repoId),
    listRepoRoots: deps.listRepoRoots ?? listRootsOf,
    updateSettings: (updates) => {
      store.updateSettings(updates)
    },
    userDataPath: deps.userDataPath ?? app.getPath('userData'),
    resolveAdapter: deps.resolveAdapter,
    platform: deps.platform,
    humanKey: HUMAN
  })
  const subscribers = new Set<WebContents>()
  const broadcast = (channel: string, payload: unknown): void => {
    for (const contents of subscribers) {
      if (!contents.isDestroyed() && isTrustedUIRenderer(contents)) {
        contents.send(channel, payload)
      }
    }
  }
  service.onState((snapshot) => broadcast('debug:state', snapshot))
  service.onOutput((events) => broadcast('debug:output', events))
  // Electron never awaits will-quit, so kill first; adapters are detached and would outlive Orca.
  app.on('will-quit', () => {
    service.killAllSync()
    void service.dispose()
  })

  // Every debug:* channel is privileged: only Orca's own UI renderer may drive a debugger.
  const result = (
    channel: string,
    listener: (p: Params, event: IpcMainInvokeEvent) => Promise<DebugResult<unknown>>
  ): void => {
    ipcMain.handle(`debug:${channel}`, async (event, params: unknown) => {
      if (!isTrustedUIRenderer(event.sender)) {
        return DEBUG_UNTRUSTED_RENDERER
      }
      try {
        return await listener(params === undefined ? {} : record(params), event)
      } catch (error) {
        return toRefusal(error)
      }
    })
  }
  const value = (channel: string, listener: (p: Params) => unknown): void =>
    result(channel, async (p) => ({ ok: true, value: (await listener(p)) ?? null }))
  // A renderer is always origin ui; only the CLI RPC passes cli.
  const control = (p: Params) => service.control(target(p), 'ui')
  const inspect = (p: Params) => service.inspect(target(p))

  value('describeAdapters', (p) => service.describeAdapters(p.repoId ? target(p) : undefined))
  result('listConfigs', (p) => service.listConfigs(text(p, 'repoId'), worktree(p)))
  result('previewLaunch', (p) => service.previewLaunch(launchTarget(p)))
  result('approveLaunch', (p) =>
    service.approveLaunch(
      { ...launchTarget(p), expectedHash: text(p, 'expectedHash') },
      humanConfirmation()
    )
  )
  result('start', (p) =>
    service.start({ ...launchTarget(p), expectedHash: optText(p, 'expectedHash'), origin: 'ui' })
  )
  result('stop', (p) => service.stop(target(p)))
  result('restart', (p) => service.restart(target(p), 'ui'))
  for (const step of ['continue', 'next', 'stepIn', 'stepOut', 'pause'] as const) {
    value(step, async (p) => (await control(p))[step](int(p, 'threadId')))
  }
  value('threads', async (p) => (await inspect(p)).threads())
  value('stackTrace', async (p) =>
    (await inspect(p)).stackTrace(int(p, 'threadId'), optInt(p, 'startFrame'), optInt(p, 'levels'))
  )
  value('scopes', async (p) => (await inspect(p)).scopes(int(p, 'frameId')))
  value('variables', async (p) =>
    (await inspect(p)).variables(
      int(p, 'variablesReference'),
      optInt(p, 'start'),
      optInt(p, 'count')
    )
  )
  value('evaluate', async (p) => {
    const context = optText(p, 'context') ?? 'repl'
    if (!isEvaluateContext(context)) {
      throw invalid('context')
    }
    return (await control(p)).evaluate(text(p, 'expression'), optInt(p, 'frameId'), context)
  })
  value('setVariable', async (p) => {
    const reference = int(p, 'variablesReference')
    return (await control(p)).setVariable(reference, text(p, 'name'), String(p.value ?? ''))
  })
  value('setExceptionFilters', (p) =>
    service.setExceptionFilters(target(p), stringList(p, 'filters'))
  )
  value('addBreakpoint', (p) => {
    const fields = breakpointFields(p)
    if (fields.line === undefined) {
      throw invalid('line')
    }
    const line = fields.line
    return service.addBreakpoint(target(p), text(p, 'path'), { ...fields, line }, 'ui')
  })
  value('updateBreakpoint', (p) =>
    service.updateBreakpoint(target(p), text(p, 'id'), breakpointFields(p.fields), 'ui')
  )
  value('removeBreakpoint', (p) => service.removeBreakpoint(target(p), text(p, 'id')))
  value('setFileLines', (p) => {
    if (!Array.isArray(p.lines)) {
      throw invalid('lines')
    }
    const lines = p.lines.map(record).map((l) => ({ id: text(l, 'id'), line: int(l, 'line') }))
    return service.setFileLines(target(p), text(p, 'path'), lines)
  })
  value('listBreakpoints', (p) => service.listBreakpoints(target(p)))
  value('snapshot', (p) => service.snapshot(target(p)))
  value('eventsSince', (p) => service.eventsSince(target(p), int(p, 'seq')))
  result('subscribe', async (_p, { sender }) => {
    if (!subscribers.has(sender)) {
      subscribers.add(sender)
      sender.once('destroyed', () => subscribers.delete(sender))
    }
    return { ok: true, value: null }
  })
}
