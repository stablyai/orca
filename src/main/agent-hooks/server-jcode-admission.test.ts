import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import { prepareJcodeHookPayload, type PreparedJcodeHook } from '../../shared/agent-hook-listener'
import { seedLegacyAgentStatusForTests } from '../../shared/agent-hook-listener/listener-state'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import { rootMetadata, tigressHooks } from '../../shared/agent-hook-listener-jcode-swarm-fixtures'

class AdmissionServer extends AgentHookServer {
  refuseWrite = false
  protected override writeLegacyStatusRow(entry: EnrichedAgentHookEventPayload): boolean {
    return !this.refuseWrite && super.writeLegacyStatusRow(entry)
  }
  ingest(body: unknown) {
    this.ingestJcodeHook(body)
  }
  applyPrepared(prepared: PreparedJcodeHook) {
    if (!prepared.event) {
      throw new Error('Expected row')
    }
    return this.applyNormalizedStatus(
      prepared.event,
      undefined,
      'hook',
      undefined,
      undefined,
      false,
      prepared.commit
    )
  }
}

describe('Jcode post-admission commits', () => {
  let dir: string
  let server: AdmissionServer
  const body = () =>
    buildBody({ ...tigressHooks[0], event: 'turn_start', prompt: 'admitted prompt' })
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jcode-admission-'))
    vi.stubEnv('JCODE_HOME', dir)
    mkdirSync(join(dir, 'sessions'))
    writeFileSync(join(dir, 'sessions', `${rootMetadata.id}.json`), JSON.stringify(rootMetadata))
    server = new AdmissionServer()
  })
  afterEach(() => {
    server.stop()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not bind or change prompt/tool/turn/roster state when final row write fails', () => {
    const state = server._getStateForTests()
    const before = structuredClone({
      ...state,
      lastStatusByPaneKey: new Map(state.lastStatusByPaneKey)
    })
    server.refuseWrite = true
    server.ingest(body())
    expect(
      structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
    ).toEqual(before)
    server.refuseWrite = false
    server.ingest(body())
    expect(state.jcodeSessions.roots.get(PANE)).toBe(rootMetadata.id)
  })

  it('returning previous owner row cannot commit a prepared Jcode input', () => {
    const state = server._getStateForTests()
    const prepared = prepareJcodeHookPayload(state, body(), 'production')
    if (!prepared) {
      throw new Error('Expected prepared input')
    }
    const owner: EnrichedAgentHookEventPayload = {
      paneKey: PANE,
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { state: 'working', prompt: 'Claude', agentType: 'claude' },
      receivedAt: Date.now(),
      stateStartedAt: Date.now()
    }
    seedLegacyAgentStatusForTests(state, owner)
    const previous = state.lastStatusByPaneKey.get(PANE)
    const registry = state.jcodeSessions
    expect(server.applyPrepared(prepared)).toBe(previous)
    expect(state.jcodeSessions).toBe(registry)
    expect(state.jcodeRootPayloadByPaneKey.size).toBe(0)
    expect(state.lastPromptByPaneKey.size).toBe(0)
  })

  it('commits launch binding before row-mutation and provider-session subscribers', () => {
    const observed: string[] = []
    const record = () => {
      observed.push(server._getStateForTests().jcodeSessions.roots.get(PANE) ?? 'missing')
    }
    server.subscribeStatusRowMutations(record)
    server.subscribeProviderSessionChanges(record)
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'jcode',
      providerSession: { key: 'session_id', id: rootMetadata.id },
      launchedAt: Date.now()
    })
    expect(observed.length).toBeGreaterThan(0)
    expect(new Set(observed)).toEqual(new Set([rootMetadata.id]))
  })

  it('fences stale normalized remote envelopes without consulting local Jcode state', () => {
    server.retirePaneAuthority(PANE)
    const event = {
      paneKey: PANE,
      source: 'jcode' as const,
      hookEventName: 'turn_start',
      providerSession: { key: 'session_id' as const, id: rootMetadata.id },
      payload: { state: 'working' as const, prompt: 'fresh remote prompt', agentType: 'jcode' }
    }
    server.ingestRemote({ ...event, launchToken: 'fresh' }, 'remote-host')
    const state = server._getStateForTests()
    const before = structuredClone({
      ...state,
      lastStatusByPaneKey: new Map(state.lastStatusByPaneKey)
    })
    server.ingestRemote(
      { ...event, launchToken: 'old', payload: { ...event.payload, prompt: 'stale prompt' } },
      'remote-host'
    )
    expect(
      structuredClone({ ...state, lastStatusByPaneKey: new Map(state.lastStatusByPaneKey) })
    ).toEqual(before)
    server.ingestRemote(
      {
        ...event,
        launchToken: 'fresh',
        payload: { ...event.payload, prompt: 'fresh second prompt' }
      },
      'remote-host'
    )
    expect(server.getStatusSnapshot()[0].prompt).toBe('fresh second prompt')
    expect(state.jcodeSessions.bindings.size).toBe(0)
    expect(state.jcodeRootPayloadByPaneKey.size).toBe(0)
  })
})
