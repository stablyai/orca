import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { AgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store'
import { readProcessStartTimesMs } from '../../src/main/runtime/agent-session-process-identity-probe'
import { StructuredAgentSessionLeaseRenewer } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-lease-renewer'

const RECORD_COUNT = 50
const NOW = 1_800_000_000_000

async function seedStore(store: AgentSessionRecordStore, directory: string): Promise<void> {
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    const sessionId = `benchmark-session-${index}`
    const spawnToken = `benchmark-spawn-${index}`
    const reserved = await store.reserveOwner({
      sessionId,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'benchmark-workspace',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: directory },
      runtimeKind: 'native',
      expectedFence: null,
      spawnToken,
      claimKeyId: 'benchmark-key',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'benchmark',
        operationId: `${NOW}-${index.toString(16).padStart(32, '0')}`,
        fingerprint: `create-${index}`
      },
      now: NOW
    })
    const fence = reserved.record.lease.runtimeFence
    await store.commitProcessIdentity({
      sessionId,
      fence,
      process: {
        hostId: 'local',
        pid: process.pid,
        processStartTimeMs: null,
        spawnToken
      },
      now: NOW
    })
    await store.proveOwner({
      sessionId,
      fence,
      link: {
        linkId: `benchmark-link-${index}`,
        handle: { provider: 'codex', threadId: `benchmark-thread-${index}` },
        origin: 'created',
        mintedAtFence: fence,
        observedAt: NOW
      },
      now: NOW
    })
  }
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-lease-renewal-benchmark-'))
  try {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await seedStore(store, directory)
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store,
      probe: async () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] }),
      now: () => NOW + 10_000
    })
    const startedAt = performance.now()
    await renewer.renewNow()
    const elapsedMs = performance.now() - startedAt
    const renewed = store
      .listRecords()
      .filter((record) => record.lease.lastRenewedAt === NOW + 10_000).length
    const processProbeStartedAt = performance.now()
    const processStartTimes = await readProcessStartTimesMs(
      Array.from({ length: RECORD_COUNT }, () => process.pid),
      'darwin'
    )
    console.log(
      JSON.stringify({
        records: RECORD_COUNT,
        renewed,
        elapsedMs,
        processTableElapsedMs: performance.now() - processProbeStartedAt,
        processTableMatches:
          processStartTimes.get(process.pid) === null ||
          processStartTimes.get(process.pid) === undefined
            ? 0
            : RECORD_COUNT
      })
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
