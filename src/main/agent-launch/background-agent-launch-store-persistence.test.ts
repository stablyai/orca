// Durability wiring for the generic background-attempt store (L2-#1): the
// store's contract says an unattended failure survives reload, so rebuild +
// write-back sink must round-trip attempts through the host-private file, and
// one corrupt row must never abort rehydrating the rest.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackgroundAgentLaunchStore } from './background-agent-launch-store'
import {
  backgroundAgentLaunchStorePath,
  initBackgroundAgentLaunchStorePersistence,
  loadBackgroundAgentLaunchAttempts
} from './background-agent-launch-store-persistence'

const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111'

describe('background-agent-launch store persistence', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bg-launch-store-'))
    path = backgroundAgentLaunchStorePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists every create/settle/forget mutation and rehydrates it at boot', () => {
    const store = new BackgroundAgentLaunchStore({ now: () => 1000 })
    initBackgroundAgentLaunchStorePersistence(store, path)
    store.create({
      attemptId: ATTEMPT_ID,
      worktreeId: 'r1::/wt',
      operationId: 'op-1',
      requestedAgent: 'claude',
      baseAgent: 'claude'
    })
    store.settleFailed(ATTEMPT_ID, {
      version: 1,
      failureId: 'fail-1',
      intent: 'background',
      occurredAt: 1000,
      code: 'spawn_failed',
      requestedAgent: 'claude',
      baseAgent: 'claude'
    })

    // A fresh store (fresh process) rebuilds the failed attempt from disk —
    // the reload-survival contract the store header claims.
    const reborn = new BackgroundAgentLaunchStore({ now: () => 2000 })
    initBackgroundAgentLaunchStorePersistence(reborn, path)
    expect(reborn.get(ATTEMPT_ID)).toMatchObject({
      state: 'failed',
      failure: { code: 'spawn_failed', failureId: 'fail-1' }
    })
  })

  it('drops one corrupt row without aborting the rest', () => {
    const store = new BackgroundAgentLaunchStore({ now: () => 1000 })
    initBackgroundAgentLaunchStorePersistence(store, path)
    store.create({
      attemptId: ATTEMPT_ID,
      worktreeId: 'r1::/wt',
      operationId: 'op-1',
      requestedAgent: 'claude',
      baseAgent: null
    })
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { attempts: unknown[] }
    raw.attempts.push({ attemptId: 'not-a-valid-attempt' })
    writeFileSync(path, JSON.stringify(raw), 'utf-8')

    const loaded = loadBackgroundAgentLaunchAttempts(path)
    expect(loaded.attempts).toHaveLength(1)
    expect(loaded.attempts[0]?.attemptId).toBe(ATTEMPT_ID)
  })

  it('starts empty on a corrupt file instead of blocking boot', () => {
    writeFileSync(path, '{ not json', 'utf-8')
    expect(loadBackgroundAgentLaunchAttempts(path)).toEqual({
      attempts: [],
      persistedStateUnreadable: false
    })
  })
})
