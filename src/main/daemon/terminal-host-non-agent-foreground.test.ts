import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type * as SnapshotReader from '../../shared/process-table-snapshot-reader'
import { inspectTerminalHostProcess } from './terminal-host-process-inspection'
import type { Session } from './session'

const { readSnapshot } = vi.hoisted(() => ({ readSnapshot: vi.fn() }))
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof SnapshotReader>()),
  getStrictProcessTableSnapshotWithAge: readSnapshot
}))

function table(command: string | null): ProcessTableRow[] {
  const foregroundPgid = command === null ? 100 : 101
  const shell: ProcessTableRow = {
    pid: 100,
    ppid: 1,
    pgid: 100,
    tpgid: foregroundPgid,
    tty: 'pts/1',
    startTime: 'shell-start',
    stat: command === null ? 'Ss+' : 'Ss',
    command: '/bin/bash'
  }
  return command === null
    ? [shell]
    : [
        shell,
        {
          ...shell,
          pid: 101,
          ppid: 100,
          pgid: 101,
          stat: 'S+',
          startTime: 'command-start',
          command
        }
      ]
}

async function inspect(rawName: string, command: string | null) {
  readSnapshot.mockResolvedValue({ rows: table(command), capturedAgeMs: 0 })
  return inspectTerminalHostProcess({
    sessionId: 'busy-tab',
    session: {
      pid: 100,
      incarnationId: 'incarnation-1',
      isAlive: true,
      getForegroundProcess: () => rawName
    } as unknown as Session,
    authorityGeneration: 'generation-1',
    nextObservationEpoch: () => 1
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  readSnapshot.mockClear()
})

describe.each(['linux', 'darwin'] as const)('daemon ordinary foreground on %s', (platform) => {
  it.each(['sleep', 'vim', 'node'])(
    'retains the running %s name alongside agent-only evidence',
    async (name) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      const result = await inspect(name, `${name} 300`)
      expect(result).toMatchObject({
        foregroundProcess: name,
        hasChildProcesses: true,
        foregroundProcessEvidence: { verdict: 'live', processName: null }
      })
      expect(readSnapshot).toHaveBeenCalledTimes(1)
    }
  )

  it('still clears a stale recognized agent after its process exits', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(await inspect('claude', null)).toMatchObject({
      foregroundProcess: null,
      foregroundProcessEvidence: { verdict: 'live', processName: null }
    })
  })

  it('still reports no foreground command for an idle shell', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    expect(await inspect('bash', null)).toMatchObject({
      foregroundProcess: null,
      hasChildProcesses: false,
      foregroundProcessEvidence: { verdict: 'live', processName: null }
    })
  })
})
