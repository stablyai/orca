import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

const roots: string[] = []
export const journals = createTrackedJournalOpener()

export function scaleRecord(sessionId: string, workspaceId = 'workspace-1', links = 1) {
  const row = agentSessionRecordFixture(
    agentSessionLeaseFixture({ sessionId, provenHandleLinkId: `link-${links - 1}` })
  )
  return {
    ...row,
    location: { ...row.location, workspaceId },
    options: { model: 'saved-model' },
    providerHandleChain: Array.from({ length: links }, (_, i) => ({
      ...row.providerHandleChain[0]!,
      linkId: `link-${i}`,
      origin: i === 0 ? ('created' as const) : ('resumed' as const),
      handle: claudeProviderHandle(`provider-${sessionId}-0`, i ? `leaf-${i}` : null)
    }))
  }
}

export async function scaleDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'orca-session-scale-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
