import { writeFile } from 'node:fs/promises'
vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async (original) => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    ...(await original<object>()),
    readOpenCodeTranscriptPageViaWorker: query.readOpenCodeTranscriptPage,
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { createRestTestRig, type RestTestRig } from './structured-agent-session-rest-test-rig'
import { createTestParams } from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})

afterEach(async () => {
  await rig.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

export async function adoptedParams(history = 'adopted history', threadId = THREAD) {
  const transcriptPath = join(rig.root, 'rollout.jsonl')
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: threadId, timestamp: '2026-09-06T18:00:00.000Z', cwd: rig.root }
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-06T18:00:01.000Z',
        payload: { type: 'message', role: 'user', content: history }
      })
    ].join('\n')
  )
  return createTestParams(undefined, {
    adopt: { providerHandle: codexProviderHandle(threadId), transcriptPath }
  })
}

export function anotherSession(params: AgentSessionAttachParams): AgentSessionAttachParams {
  return createTestParams(undefined, {
    ...params,
    envelope: {
      ...params.envelope,
      sessionId: 'session-second',
      clientOperationId: hostTestOperationId()
    }
  })
}

export const fixture = {
  get rig() {
    return rig
  },
  set rig(value: typeof rig) {
    rig = value
  }
}
