import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import { PtyHandler } from './pty-handler'
import { ZmxPtySupervisor } from './zmx-pty-supervisor'

type RequestHandler = (params: Record<string, unknown>, context?: RequestContext) => unknown

function resolveZmxPath(): string | null {
  if (process.platform === 'win32') {
    return null
  }
  try {
    return execFileSync('/bin/sh', ['-lc', 'command -v zmx'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function createDispatcher(): {
  dispatcher: RelayDispatcher
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
  notifications: { method: string; params: Record<string, unknown> }[]
} {
  const requests = new Map<string, RequestHandler>()
  const notifications = new Map<string, (params: Record<string, unknown>) => void>()
  const published: { method: string; params: Record<string, unknown> }[] = []
  const dispatcher = {
    onRequest: vi.fn((method: string, handler: RequestHandler) => requests.set(method, handler)),
    onNotification: vi.fn((method: string, handler: (params: Record<string, unknown>) => void) =>
      notifications.set(method, handler)
    ),
    notify: vi.fn((method: string, params: Record<string, unknown> = {}) => {
      published.push({ method, params })
    })
  } as unknown as RelayDispatcher
  return {
    dispatcher,
    request: async (method, params = {}) => await requests.get(method)!(params),
    notify: (method, params = {}) => notifications.get(method)!(params),
    notifications: published
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for zmx lifecycle condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

const zmxPath = resolveZmxPath()
const describeWithZmx = zmxPath ? describe : describe.skip

describeWithZmx('zmx PTY lifecycle', () => {
  let firstHandler: PtyHandler | null = null
  let replacementHandler: PtyHandler | null = null
  let storageRoot = ''
  let supervisor: ZmxPtySupervisor | null = null

  afterEach(async () => {
    await firstHandler?.dispose({ waitForPhysicalExit: false }).catch(() => {})
    await replacementHandler?.dispose({ waitForPhysicalExit: false }).catch(() => {})
    await supervisor?.killSession('pty-1').catch(() => {})
    if (storageRoot) {
      rmSync(storageRoot, { recursive: true, force: true })
    }
  })

  it('survives relay disposal, reattaches, and ends explicitly', async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'orca-zmx-lifecycle-'))
    const options = {
      zmx: { executablePath: zmxPath!, namespace: 'integration', storageRoot }
    }
    supervisor = new ZmxPtySupervisor(options.zmx)
    const first = createDispatcher()
    firstHandler = new PtyHandler(first.dispatcher, 0, options)

    const spawned = (await first.request('pty.spawn', {
      cols: 80,
      rows: 24,
      cwd: storageRoot,
      shellOverride: '/bin/sh'
    })) as { id: string; incarnationId: string }
    first.notify('pty.data', { id: spawned.id, data: "printf 'before-reset-marker\\n'\n" })
    await waitFor(() =>
      first.notifications.some(
        (entry) => entry.method === 'pty.data' && String(entry.params.data).includes('before-reset')
      )
    )

    await firstHandler.dispose()
    firstHandler = null
    expect(await supervisor.listSessionNames()).toContain(spawned.id)

    const replacement = createDispatcher()
    replacementHandler = new PtyHandler(replacement.dispatcher, 0, options)
    const discovered = (await replacement.request('pty.listProcesses')) as {
      id: string
      incarnationId: string
    }[]
    expect(discovered).toContainEqual(
      expect.objectContaining({ id: spawned.id, incarnationId: spawned.incarnationId })
    )

    const attached = (await replacement.request('pty.attach', { id: spawned.id })) as {
      incarnationId: string
    }
    expect(attached.incarnationId).toBe(spawned.incarnationId)
    replacement.notify('pty.data', { id: spawned.id, data: "printf 'after-reset-marker\\n'\n" })
    await waitFor(() =>
      replacement.notifications.some(
        (entry) => entry.method === 'pty.data' && String(entry.params.data).includes('after-reset')
      )
    )

    await replacement.request('pty.shutdown', { id: spawned.id, immediate: true })
    await waitFor(async () => !(await supervisor!.listSessionNames()).includes(spawned.id))
  }, 30_000)

  it('ends the durable session when an idle shell receives Ctrl+D', async () => {
    storageRoot = mkdtempSync(join(tmpdir(), 'orca-zmx-ctrl-d-'))
    const options = {
      zmx: { executablePath: zmxPath!, namespace: 'integration', storageRoot }
    }
    supervisor = new ZmxPtySupervisor(options.zmx)
    const first = createDispatcher()
    firstHandler = new PtyHandler(first.dispatcher, 0, options)

    const spawned = (await first.request('pty.spawn', {
      cols: 80,
      rows: 24,
      cwd: storageRoot,
      shellOverride: '/bin/sh'
    })) as { id: string }

    first.notify('pty.data', { id: spawned.id, data: '\x04' })

    await waitFor(async () => !(await supervisor!.listSessionNames()).includes(spawned.id))
    await waitFor(() =>
      first.notifications.some(
        (entry) => entry.method === 'pty.exit' && entry.params.id === spawned.id
      )
    )
    expect(await supervisor.readMetadata(spawned.id)).toBeNull()
  }, 30_000)
})
