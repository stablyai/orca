import { describe, expect, it } from 'vitest'
import {
  findAgentSessionSpawnTokenProcesses,
  scanAgentSessionSpawnTokenProcesses
} from './agent-session-spawn-token-process-scan'

describe('agent-session spawn token process scan', () => {
  it('answers null on platforms that cannot read another process environment', async () => {
    // macOS and Windows have no `/proc/<pid>/environ`. Answering "none" there would free a
    // reservation whose child is alive and mint a second writer on the same provider session.
    expect(await scanAgentSessionSpawnTokenProcesses('darwin')).toBeNull()
    expect(await scanAgentSessionSpawnTokenProcesses('win32')).toBeNull()
  })

  it('propagates the host non-answer rather than reporting an empty pid list', async () => {
    expect(await findAgentSessionSpawnTokenProcesses('token-1', async () => null)).toBeNull()
  })

  it('reports the pids carrying one token', async () => {
    const scan = async () => new Map([['token-1', [11, 12]]])

    expect(await findAgentSessionSpawnTokenProcesses('token-1', scan)).toEqual([11, 12])
    expect(await findAgentSessionSpawnTokenProcesses('token-2', scan)).toEqual([])
  })
})
