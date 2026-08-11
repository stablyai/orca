import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { PtyHandler } from './pty-handler'

type GridReport = {
  event: 'armed' | 'ready' | 'probe' | 'winch'
  cols: number
  rows: number
  winches: number
}

type RequestHandler = (params: Record<string, unknown>, context: RequestContext) => Promise<unknown>
type NotificationHandler = (params: Record<string, unknown>, context: RequestContext) => void

const REPORT_PREFIX = '__ORCA_ATTACH_GRID__'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function processEnvironment(home: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries({ ...process.env, HOME: home }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
}

class GridReportStream {
  private buffered = ''
  private reports: GridReport[] = []
  private listeners = new Set<() => void>()

  push(data: string): void {
    this.buffered += data
    const lines = this.buffered.split(/\r?\n/)
    this.buffered = lines.pop() ?? ''
    for (const line of lines) {
      const marker = line.lastIndexOf(REPORT_PREFIX)
      if (marker < 0) {
        continue
      }
      try {
        this.reports.push(JSON.parse(line.slice(marker + REPORT_PREFIX.length)) as GridReport)
      } catch {
        // The shell echoes the child source before the real report arrives.
      }
    }
    for (const listener of this.listeners) {
      listener()
    }
  }

  count(): number {
    return this.reports.length
  }

  async waitFor(predicate: (report: GridReport) => boolean, startAt = 0): Promise<GridReport> {
    const existing = this.reports.slice(startAt).find(predicate)
    if (existing) {
      return existing
    }
    return await new Promise<GridReport>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.listeners.delete(check)
        reject(new Error(`Timed out waiting for PTY report: ${JSON.stringify(this.reports)}`))
      }, 5_000)
      const check = (): void => {
        const report = this.reports.slice(startAt).find(predicate)
        if (!report) {
          return
        }
        clearTimeout(timeout)
        this.listeners.delete(check)
        resolve(report)
      }
      this.listeners.add(check)
    })
  }
}

function createDispatcher(reports: GridReportStream): {
  dispatcher: RelayDispatcher
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  notify: (method: string, params: Record<string, unknown>) => void
} {
  const requests = new Map<string, RequestHandler>()
  const notifications = new Map<string, NotificationHandler>()
  const context = { clientId: 1, isStale: () => false } as RequestContext
  const dispatcher = {
    onRequest: (method: string, handler: RequestHandler) => requests.set(method, handler),
    onNotification: (method: string, handler: NotificationHandler) =>
      notifications.set(method, handler),
    notify: (method: string, params?: Record<string, unknown>) => {
      if (method === 'pty.data' && typeof params?.data === 'string') {
        reports.push(params.data)
      }
    }
  } as unknown as RelayDispatcher
  return {
    dispatcher,
    request: async (method, params) => {
      const handler = requests.get(method)
      if (!handler) {
        throw new Error(`Missing request handler: ${method}`)
      }
      return await handler(params, context)
    },
    notify: (method, params) => {
      const handler = notifications.get(method)
      if (!handler) {
        throw new Error(`Missing notification handler: ${method}`)
      }
      handler(params, context)
    }
  }
}

function gridChildSource(): string {
  return [
    'let winches=0',
    `const report=event=>process.stdout.write('\\n${REPORT_PREFIX}'+JSON.stringify({event,cols:process.stdout.columns,rows:process.stdout.rows,winches})+'\\n')`,
    "process.on('SIGWINCH',()=>{winches+=1;report('winch')})",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data',data=>{if(data.includes('arm'))setImmediate(()=>{winches=0;report('armed')});if(data.includes('probe'))report('probe');if(data.includes('exit'))process.exit(0)})",
    'process.stdin.resume()',
    "report('ready')"
  ].join(';')
}

describe.skipIf(process.platform === 'win32')('relay PTY attach viewport', () => {
  let handler: PtyHandler | null = null
  let temporaryHome: string | null = null

  afterEach(async () => {
    await handler?.dispose({ waitForPhysicalExit: false })
    if (temporaryHome) {
      rmSync(temporaryHome, { recursive: true, force: true })
    }
  })

  it('applies reattach geometry to the real child and delivers SIGWINCH', async () => {
    temporaryHome = mkdtempSync(join(tmpdir(), 'orca-pty-attach-grid-'))
    const reports = new GridReportStream()
    const harness = createDispatcher(reports)
    handler = new PtyHandler(harness.dispatcher)
    const spawned = (await harness.request('pty.spawn', {
      cols: 200,
      rows: 50,
      cwd: temporaryHome,
      shellOverride: '/bin/sh',
      env: processEnvironment(temporaryHome)
    })) as { id: string }
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(gridChildSource())}\n`
    harness.notify('pty.data', { id: spawned.id, data: command })

    await expect(reports.waitFor((report) => report.event === 'ready')).resolves.toMatchObject({
      cols: 200,
      rows: 50,
      winches: 0
    })
    harness.notify('pty.data', { id: spawned.id, data: 'arm\n' })
    await expect(reports.waitFor((report) => report.event === 'armed')).resolves.toMatchObject({
      cols: 200,
      rows: 50,
      winches: 0
    })
    const attachReportStart = reports.count()
    await harness.request('pty.attach', { id: spawned.id, cols: 105, rows: 30 })
    harness.notify('pty.data', { id: spawned.id, data: 'probe\n' })

    await expect(reports.waitFor((report) => report.event === 'probe')).resolves.toMatchObject({
      cols: 105,
      rows: 30
    })
    const winch = await reports.waitFor((report) => report.event === 'winch', attachReportStart)
    expect(winch.winches).toBeGreaterThanOrEqual(1)
  })
})
