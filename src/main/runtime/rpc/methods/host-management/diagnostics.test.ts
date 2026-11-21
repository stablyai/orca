import { describe, expect, it } from 'vitest'
import type { MemorySnapshot } from '../../../../../shared/diagnostics/process-stats-types'
import type { RpcContext } from '../../core'
import { DIAGNOSTICS_METHODS } from './diagnostics'

// Well past the 4 MiB a remote reply can carry.
const history = Array.from({ length: 60 }, () => 123_456_789_012)
const worktrees = Array.from({ length: 4_000 }, (_, i) => ({
  worktreeId: `w-${i}-${'x'.repeat(300)}`,
  worktreeName: 'main',
  repoId: 'repo',
  repoName: 'repo',
  cpu: 0.1,
  memory: 100,
  sessions: [],
  history
}))
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reply reads only the fields set here.
const snapshot = {
  app: { cpu: 1, memory: 1_000, main: {}, renderer: {}, other: {}, history },
  worktrees,
  totalCpu: 1,
  totalMemory: 1_000
} as unknown as MemorySnapshot

function memoryFor(caller: RpcContext['caller']): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the runtime snapshot and caller.
  const ctx = {
    runtime: { getMemorySnapshot: async () => snapshot },
    caller
  } as unknown as RpcContext
  return DIAGNOSTICS_METHODS[0].handler(null, ctx)
}

describe('diagnostics.memory', () => {
  it('gives the local CLI the whole snapshot, history included', async () => {
    expect(await memoryFor({ kind: 'local-cli' })).toBe(snapshot)
  })

  it('trims a reply for a paired device to what a remote connection carries', async () => {
    const reply = await memoryFor({ kind: 'paired-device', deviceId: 'd1' })
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(4 * 1024 * 1024)
  })
})
