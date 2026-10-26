import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'
import {
  skunkHooks,
  skunkMetadata,
  usageA,
  usageB
} from '../../shared/agent-hook-listener-jcode-usage-fixtures'

describe('Jcode usage desktop persistence', () => {
  let dir: string
  let server: AgentHookServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-main-usage-'))
    vi.stubEnv('JCODE_HOME', join(dir, 'jcode'))
    server = new AgentHookServer()
    await server.start({ userDataPath: dir, env: 'production' })
  })

  afterEach(() => {
    server.stop()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function documents() {
    const sessions = join(dir, 'jcode', 'sessions')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, `${skunkMetadata.id}.json`), JSON.stringify(skunkMetadata))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 251)
  }

  async function post(payload: Record<string, unknown>) {
    expect((await postHookEvent(server, buildBody(payload), '/hook/jcode')).status).toBe(204)
  }

  it('keeps usage across a same-session session_start, a snapshot and a restart', async () => {
    documents()
    await post(skunkHooks.sessionStart)
    await post(skunkHooks.turnStartA)
    await post(skunkHooks.postToolWrite)
    await post(skunkHooks.turnEndA)
    expect(server.getStatusSnapshot()[0].lastTurnUsage).toEqual(usageA)
    await post(skunkHooks.sessionStart)
    expect(server.getStatusSnapshot()[0].lastTurnUsage).toEqual(usageA)

    await server.stop()
    server = new AgentHookServer()
    await server.start({ userDataPath: dir, env: 'production' })
    expect(server.getStatusSnapshot()[0].lastTurnUsage).toEqual(usageA)
    await post(skunkHooks.turnStartB)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', lastTurnUsage: usageA })
    await post(skunkHooks.turnEndB)
    expect(server.getStatusSnapshot()[0].lastTurnUsage).toEqual(usageB)
  })

  it('leaves the row unchanged after a duplicate tokenless turn_end', async () => {
    documents()
    for (const payload of [
      skunkHooks.sessionStart,
      skunkHooks.turnStartA,
      skunkHooks.postToolWrite,
      skunkHooks.turnEndA,
      skunkHooks.turnStartB,
      skunkHooks.postToolEdit,
      skunkHooks.turnEndB
    ]) {
      await post(payload)
    }
    const row = server.getStatusSnapshot()[0]
    expect(row.lastTurnUsage).toEqual(usageB)
    // Negative control: duplicate captured turn B with every token field removed.
    const tokenless: Record<string, unknown> = { ...skunkHooks.turnEndB }
    for (const key of Object.keys(tokenless)) {
      if (key.endsWith('_tokens')) {
        delete tokenless[key]
      }
    }
    await post(tokenless)
    expect(server.getStatusSnapshot()[0]).toEqual(row)
    expect(server.getStatusSnapshot()[0].lastTurnUsage).toEqual(usageB)
    await post(skunkHooks.turnStartC)
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', lastTurnUsage: usageB })
  })
})
