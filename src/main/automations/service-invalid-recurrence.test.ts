import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../shared/persisted-state-types'
import {
  createStore,
  makeRepo,
  readDataFile,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import { AutomationService } from './service'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(plaintext),
    decryptString: (ciphertext: Buffer) => ciphertext.toString()
  }
}))

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-invalid-recurrence-'))
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-06T08:59:00'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('pauses an unsupported persisted RRULE without blocking another due automation', async () => {
  const initial = await createStore()
  initial.addRepo(makeRepo())
  const input = {
    name: 'A unsupported',
    prompt: 'Review',
    agentId: 'codex' as const,
    projectId: 'r1',
    workspaceMode: 'existing' as const,
    workspaceId: 'wt1',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: Date.parse('2026-09-01T00:00:00')
  }
  const bad = initial.createAutomation(input)
  const good = initial.createAutomation({ ...input, name: 'B valid' })
  initial.flush()
  const state = readDataFile() as PersistedState
  state.automations.find((entry) => entry.id === bad.id)!.rrule += ';COUNT=1'
  writeDataFile(state)
  const store = await createStore()
  vi.setSystemTime(new Date('2026-09-06T09:01:00'))
  const send = vi.fn()
  const service = new AutomationService(store)
  service.setWebContents({ isDestroyed: () => false, send } as never)
  service.start()
  try {
    service.setRendererReady()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][1].automation.id).toBe(good.id)
    expect(store.listAutomations().find((entry) => entry.id === bad.id)?.enabled).toBe(false)
    expect(store.listAutomationRuns(bad.id)[0]).toMatchObject({
      status: 'skipped_unavailable',
      error: expect.stringContaining('Invalid automation schedule')
    })
    expect(store.listAutomations().find((entry) => entry.id === bad.id)?.rrule).toContain('COUNT=1')
  } finally {
    service.stop()
  }
})
