import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

describe('status recovery write scheduling', () => {
  let userDataPath: string
  let server: AgentHookServer

  beforeEach(async () => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-status-persist-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const postPrompt = (prompt: string): Promise<Response> =>
    postHookEvent(server, buildBody({ hook_event_name: 'UserPromptSubmit', prompt }))

  function snapshot(): string {
    return readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
  }

  it('batches ongoing updates while persisting the latest state every five seconds', async () => {
    await postPrompt('baseline')
    server.flushStatusPersistSync()
    const baseline = snapshot()
    await postPrompt('first pending')
    for (let index = 1; index < 10; index++) {
      await vi.advanceTimersByTimeAsync(500)
      await postPrompt(`pending ${index}`)
      expect(snapshot()).toBe(baseline)
    }
    await vi.advanceTimersByTimeAsync(500)
    expect(snapshot()).toContain('pending 9')
    const firstWindow = snapshot()
    await postPrompt('next window')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(snapshot()).toBe(firstWindow)
    await vi.advanceTimersByTimeAsync(1)
    expect(snapshot()).toContain('next window')
  })

  it('flushes pending state on shutdown and cancels the scheduled write', async () => {
    await postPrompt('save on shutdown')
    server.stop()
    expect(snapshot()).toContain('save on shutdown')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(snapshot()).toContain('save on shutdown')
  })
})
