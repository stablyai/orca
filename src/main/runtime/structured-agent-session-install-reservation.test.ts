import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import * as profileStoragePaths from '../orca-profiles/profile-storage-paths'
import * as recordStoreSlot from './agent-session-record-store-slot'
import * as sessionRegistry from '../native-chat/agent-session-wire/structured-agent-session-registry'
import * as catalogRuntime from './structured-agent-model-catalog-wiring'
import { OrcaRuntimeService } from './orca-runtime'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'

it('reserves a requested host installation before shutdown can inspect it', async () => {
  let rejectOpening: (error: Error) => void = () => {}
  const opening = new Promise<never>((_, reject) => {
    rejectOpening = reject
  })
  void opening.catch(() => {})
  const open = vi.spyOn(recordStoreSlot, 'openAgentSessionRecordStoreOnce').mockReturnValue(opening)
  vi.spyOn(recordStoreSlot, 'releaseAgentSessionRecordStore').mockResolvedValue(null)
  vi.spyOn(agentModelCatalogStore, 'flushPersistence').mockResolvedValue()
  vi.spyOn(profileStoragePaths, 'getProfileUserDataPath').mockReturnValue(
    join(tmpdir(), 'orca-structured-install-never-opened')
  )
  const published = vi.spyOn(sessionRegistry, 'setStructuredAgentSessionHost')
  const ownerStop = vi.spyOn(catalogRuntime, 'stopStructuredAgentModelCatalogOwner')
  const settled: string[] = []
  const runtime = new OrcaRuntimeService()
  const ensuring = runtime.ensureStructuredAgentSessionHost().catch((error: unknown) => {
    settled.push('installation')
    return error
  })
  let stopped = false
  const stopping = stopStructuredAgentSessionRuntime().then(() => {
    stopped = true
    settled.push('shutdown')
  })
  try {
    const stoppingOwner = ownerStop.mock.results[0]
    expect(ownerStop).toHaveBeenCalledTimes(1)
    if (!stoppingOwner || stoppingOwner.type !== 'return') {
      throw new Error('Shutdown must start the actual catalog owner stop')
    }
    const ownerSettled = stoppingOwner.value.then(() => {
      settled.push('owner')
    })
    expect(open).toHaveBeenCalledTimes(0)
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
    const error = await ensuring
    await ownerSettled
    await stopping
    expect(error).toEqual(new Error('catalog runtime stopped during construction'))
    expect(settled).toEqual(['owner', 'installation', 'shutdown'])
    expect(open).toHaveBeenCalledTimes(0)
    expect(sessionRegistry.getStructuredAgentSessionHost()).toBeNull()
    expect(published).toHaveBeenCalledWith(null)
    expect(published.mock.calls.every(([host]) => host === null)).toBe(true)
  } finally {
    try {
      rejectOpening(new Error('The test refuses the blocked database open'))
      await ensuring
      await stopping
      await stopStructuredAgentSessionRuntime()
    } finally {
      vi.restoreAllMocks()
    }
  }
})

it('waits for the reserved installation once its journal opening has started', async () => {
  let rejectOpening: (error: Error) => void = () => {}
  const opening = new Promise<never>((_, reject) => {
    rejectOpening = reject
  })
  void opening.catch(() => {})
  let notifyOpening: () => void = () => {}
  const openingStarted = new Promise<void>((resolve) => {
    notifyOpening = resolve
  })
  const settled: string[] = []
  const open = vi
    .spyOn(recordStoreSlot, 'openAgentSessionRecordStoreOnce')
    .mockImplementation(() => {
      settled.push('opening')
      notifyOpening()
      return opening
    })
  vi.spyOn(recordStoreSlot, 'releaseAgentSessionRecordStore').mockResolvedValue(null)
  vi.spyOn(agentModelCatalogStore, 'flushPersistence').mockResolvedValue()
  vi.spyOn(profileStoragePaths, 'getProfileUserDataPath').mockReturnValue(
    join(tmpdir(), 'orca-structured-install-never-opened')
  )
  const published = vi.spyOn(sessionRegistry, 'setStructuredAgentSessionHost')
  const runtime = new OrcaRuntimeService()
  const ensuring = runtime.ensureStructuredAgentSessionHost().catch((error: unknown) => {
    settled.push('installation')
    return error
  })
  const openingError = new Error('The test refuses the blocked database open')
  let stopped = false
  let stopping: Promise<void> | undefined
  try {
    await Promise.race([
      openingStarted,
      ensuring.then((error) => {
        throw error
      })
    ])
    stopping = stopStructuredAgentSessionRuntime().then(() => {
      stopped = true
      settled.push('shutdown')
    })
    expect(open).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(sessionRegistry.getStructuredAgentSessionHost()).toBeNull()
    settled.push('opening rejection')
    rejectOpening(openingError)
    expect(await ensuring).toBe(openingError)
    await stopping
    expect(settled).toEqual(['opening', 'opening rejection', 'installation', 'shutdown'])
    expect(open).toHaveBeenCalledTimes(1)
    expect(sessionRegistry.getStructuredAgentSessionHost()).toBeNull()
    expect(published).toHaveBeenCalledWith(null)
    expect(published.mock.calls.every(([host]) => host === null)).toBe(true)
  } finally {
    try {
      rejectOpening(openingError)
      await ensuring
      await stopping
      await stopStructuredAgentSessionRuntime()
    } finally {
      vi.restoreAllMocks()
    }
  }
})
