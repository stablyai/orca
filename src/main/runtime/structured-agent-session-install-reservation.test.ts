import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import * as profileStoragePaths from '../orca-profiles/profile-storage-paths'
import * as recordStoreSlot from './agent-session-record-store-slot'
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
  const runtime = new OrcaRuntimeService()
  const ensuring = runtime.ensureStructuredAgentSessionHost().catch((error: unknown) => error)
  let stopped = false
  const stopping = stopStructuredAgentSessionRuntime().then(() => {
    stopped = true
  })
  try {
    expect(open).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(stopped).toBe(false)
  } finally {
    rejectOpening(new Error('The test refuses the blocked database open'))
    await ensuring
    await stopping
    await stopStructuredAgentSessionRuntime()
    vi.restoreAllMocks()
  }
})
