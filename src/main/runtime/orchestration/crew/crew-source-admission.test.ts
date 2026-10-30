import '../../rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as profileStorage from '../../../orca-profiles/profile-storage-paths'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  peekOpenedAgentSessionRecordStore,
  releaseAgentSessionRecordStore
} from '../../agent-session-record-store-slot'
import { ORCHESTRATION_CREW_METHODS } from '../../rpc/methods/orchestration/crew-methods'
import { emptyCrew, type OrchestrationCrewFrame } from '../../../../shared/orchestration-crew'
import {
  StructuredWorkerIdentityRegistry,
  type StructuredWorkerIdentity
} from '../../structured-worker-identity'
import { sessionCrewChanges } from './crew-changes'

const subscribe = ORCHESTRATION_CREW_METHODS[0].handler

afterEach(async () => {
  const opened = await releaseAgentSessionRecordStore()
  opened?.journalDatabase.close()
  vi.restoreAllMocks()
})

it('opens the production admission slot before watch and first completed frame, and leaves it owned after unsubscribe', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr34890-crew-admission-'))
  vi.spyOn(profileStorage, 'getProfileUserDataPath').mockReturnValue(directory)
  const runtime = new OrcaRuntimeService()
  const events: string[] = []
  const frames: OrchestrationCrewFrame[] = []
  const host = vi.spyOn(runtime, 'ensureStructuredAgentSessionHost')
  const open = vi.spyOn(runtime, 'openAgentSessionRecordStore')
  const read = vi.spyOn(runtime, 'getOrchestrationCrewSnapshot').mockImplementation(() => {
    expect(peekOpenedAgentSessionRecordStore()).not.toBeNull()
    events.push('read')
    return emptyCrew('ok')
  })
  const unwatch = vi.fn()
  vi.spyOn(runtime, 'watchOrchestrationCrew').mockImplementation(() => {
    expect(peekOpenedAgentSessionRecordStore()).not.toBeNull()
    events.push('watch')
    return unwatch
  })
  const controller = new AbortController()
  const completed = Promise.withResolvers<void>()
  const stream = subscribe(
    { party: 'term_viewer' },
    { runtime, signal: controller.signal },
    (frame) => {
      frames.push(frame)
      if (frame.type === 'complete') {
        completed.resolve()
      }
    }
  )
  await completed.promise
  const store = peekOpenedAgentSessionRecordStore()
  expect(events).toEqual(['watch', 'read'])
  expect(frames).toEqual([{ type: 'begin', status: 'ok' }, { type: 'complete' }])
  expect(open).toHaveBeenCalledOnce()
  expect(host).not.toHaveBeenCalled()
  expect(await runtime.openAgentSessionRecordStore()).toBe(store)
  controller.abort()
  await stream
  expect(read).toHaveBeenCalledOnce()
  expect(unwatch).toHaveBeenCalledOnce()
  expect(frames.at(-1)).toEqual({ type: 'end' })
  expect(peekOpenedAgentSessionRecordStore()).toBe(store)
})

it('cancels preparation without installing a stream or publishing, while the shared open remains usable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-pr34890-crew-cancel-'))
  vi.spyOn(profileStorage, 'getProfileUserDataPath').mockReturnValue(directory)
  const runtime = new OrcaRuntimeService()
  const actualOpen = runtime.openAgentSessionRecordStore.bind(runtime)
  const gate = Promise.withResolvers<void>()
  const open = vi.spyOn(runtime, 'openAgentSessionRecordStore').mockImplementation(async () => {
    await gate.promise
    return actualOpen()
  })
  const watch = vi.spyOn(runtime, 'watchOrchestrationCrew')
  const read = vi.spyOn(runtime, 'getOrchestrationCrewSnapshot')
  const register = vi.spyOn(runtime, 'registerSubscriptionCleanup')
  const emit = vi.fn()
  const controller = new AbortController()
  const stream = subscribe({ party: 'term_viewer' }, { runtime, signal: controller.signal }, emit)
  expect(open).toHaveBeenCalledOnce()
  controller.abort()
  gate.resolve()
  await stream
  expect(peekOpenedAgentSessionRecordStore()).not.toBeNull()
  expect(await actualOpen()).toBe(peekOpenedAgentSessionRecordStore())
  expect(watch).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  expect(register).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
  await subscribe({ party: 'term_viewer' }, { runtime, signal: controller.signal }, emit)
  expect(open).toHaveBeenCalledOnce()
})

it('wakes from actual registry changes and preserves equal replacement and forget alias semantics', () => {
  const registry = new StructuredWorkerIdentityRegistry()
  const identity: StructuredWorkerIdentity = {
    handle: 'structworker_crew-source',
    sessionId: 'crew-source',
    agent: 'codex',
    paneKey: 'session-source:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    processIncarnation: 'structured:crew-source',
    worktreeId: 'folder-source',
    hostScope: { kind: 'local', hostId: 'local' }
  }
  const wake = vi.fn()
  const stop = sessionCrewChanges.subscribe(wake)
  try {
    registry.register(identity)
    expect(wake).toHaveBeenCalledTimes(1)
    const equal = structuredClone(identity)
    expect(registry.register(equal)).toBe(equal)
    expect(registry.get(identity.handle)).toBe(equal)
    expect(wake).toHaveBeenCalledTimes(1)
    const other = { ...identity, handle: 'structworker_crew-other' }
    registry.register(other)
    expect(wake).toHaveBeenCalledTimes(2)
    registry.forget(identity.handle)
    expect(registry.getBySessionId(identity.sessionId)).toBe(other)
    expect(wake).toHaveBeenCalledTimes(3)
    registry.forget(identity.handle)
    expect(wake).toHaveBeenCalledTimes(3)
    registry.clear()
    expect(wake).toHaveBeenCalledTimes(4)
    registry.clear()
    expect(wake).toHaveBeenCalledTimes(4)
  } finally {
    stop()
  }
})
