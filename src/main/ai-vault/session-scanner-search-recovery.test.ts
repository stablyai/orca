import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from './session-scanner-service-protocol'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

vi.mock('./session-scanner', () => ({ scanAiVaultSessions: vi.fn() }))
vi.mock('./session-parse-cache-persistence', () => ({
  flushSessionParseCachePersist: vi.fn(async () => undefined),
  initSessionParseCachePersistence: vi.fn()
}))

it('clears a corrupt index after enabled scanner initialization failed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ss-recovery-'))
  const databasePath = join(directory, 'index.sqlite')
  await writeFile(databasePath, 'corrupt fixture')
  const previousSend = process.send
  const events = ['message', 'disconnect', 'SIGTERM'] as const
  const previousListeners = new Map(events.map((event) => [event, process.listeners(event)]))
  const sent: { type: string; id?: number; value?: unknown }[] = []
  process.send = ((message: (typeof sent)[number]) => {
    sent.push(message)
    return true
  }) as typeof process.send
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const emit = (value: unknown): void => {
    process.emit('message', value as never, undefined as never)
  }
  try {
    await import('./session-scanner-service-entry')
    emit({
      type: 'init',
      protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION,
      sessionSearch: { databasePath, enabled: true, paused: true, historyDays: null }
    })
    expect(errors).toHaveBeenCalled()
    expect(sent).toContainEqual(expect.objectContaining({ type: 'ready' }))
    emit({
      type: 'request',
      id: 1,
      operation: 'searchConfigure',
      request: {
        init: { databasePath, enabled: false, historyDays: null },
        roots: isolatedScanRoots(directory),
        clearIndex: true
      }
    })
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'result',
          id: 1,
          value: expect.objectContaining({ enabled: false })
        })
      )
    )
    await expect(access(databasePath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    for (const event of events) {
      for (const listener of process.listeners(event)) {
        if (!previousListeners.get(event)!.includes(listener)) {
          process.removeListener(event, listener)
        }
      }
    }
    process.send = previousSend
    errors.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
