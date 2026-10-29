import type { IPty } from 'node-pty'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SnapshotReader from '../../shared/process-table-snapshot-reader'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'

const { readRows, readStrict } = vi.hoisted(() => ({ readRows: vi.fn(), readStrict: vi.fn() }))
vi.mock('../../shared/process-table-snapshot-reader', async (original) => ({
  ...(await original<typeof SnapshotReader>()),
  getProcessTableSnapshot: readRows,
  getFreshProcessTableSnapshot: readRows,
  getStrictProcessTableSnapshotWithAge: readStrict
}))
vi.mock('./posix-pane-foreground-fingerprint', () => ({
  buildPaneProcessFingerprint: async () => 'fixture-fingerprint'
}))

import { ClaudePeerIdentityReader } from '../claude/claude-peer-identity'
import { LocalPtyProvider } from './local-pty-provider'
import {
  clearPtyState,
  ptyClaudePeerReaders,
  ptyIncarnations,
  ptyLastRecognizedForeground,
  ptyProcesses,
  ptyShellPath
} from './local-pty-provider-state'

const ID = 'peer-posix-fixture'
const SHELL_PID = 4100
const AGENT_PID = 4200
let directory: string

function rows(): ProcessTableRow[] {
  const shell = {
    pid: SHELL_PID,
    ppid: 1,
    pgid: SHELL_PID,
    tpgid: AGENT_PID,
    tty: 'ttys009',
    startTime: 'fixture-shell-start',
    stat: 'Ss',
    command: '/bin/zsh'
  }
  return [
    shell,
    {
      ...shell,
      pid: AGENT_PID,
      ppid: SHELL_PID,
      pgid: AGENT_PID,
      stat: 'S+',
      startTime: 'fixture-agent-start',
      command: 'node /usr/local/bin/claude'
    }
  ]
}

function registerPane(spawnFile: boolean): void {
  const proc: IPty & { processNameIsSpawnFile: boolean } = {
    pid: SHELL_PID,
    cols: 80,
    rows: 24,
    process: spawnFile ? '/bin/zsh' : 'node',
    processNameIsSpawnFile: spawnFile,
    handleFlowControl: false,
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    resize() {},
    clear() {},
    write() {},
    kill() {},
    pause() {},
    resume() {}
  }
  ptyProcesses.set(ID, proc)
  ptyIncarnations.set(ID, 'fixture-incarnation')
  ptyShellPath.set(ID, '/bin/zsh')
  ptyClaudePeerReaders.set(ID, new ClaudePeerIdentityReader(directory, ''))
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-local-peer-'))
  await mkdir(join(directory, 'sessions'))
  await writeFile(
    join(directory, 'sessions', `${AGENT_PID}.json`),
    JSON.stringify({
      pid: AGENT_PID,
      name: 'Amber Harbor',
      permissionMode: 'plan'
    })
  )
  readRows.mockResolvedValue(rows())
  readStrict.mockResolvedValue({ rows: rows(), capturedAgeMs: 0 })
})

afterEach(async () => {
  clearPtyState(ID)
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe.each(['darwin', 'linux'] as const)('local peer identity on %s', (platform) => {
  it.each([false, true])('retains the outer wrapper PID with spawnFile=%s', async (spawnFile) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const snapshot = rows().map((row) =>
      row.pid === AGENT_PID ? { ...row, stat: 'S', command: 'omp' } : row
    )
    const wrapper = snapshot.find((row) => row.pid === AGENT_PID)
    if (!wrapper) {
      throw new Error('wrapper fixture is missing')
    }
    snapshot.push({ ...wrapper, pid: AGENT_PID + 1, ppid: AGENT_PID, stat: 'S+', command: 'pi' })
    readRows.mockResolvedValue(snapshot)
    readStrict.mockResolvedValue({ rows: snapshot, capturedAgeMs: 0 })
    registerPane(spawnFile)
    expect(await new LocalPtyProvider().inspectProcess(ID)).toMatchObject({
      foregroundProcess: 'omp'
    })
    expect(ptyLastRecognizedForeground.get(ID)?.pid).toBe(AGENT_PID)
  })

  it.each([false, true])(
    'reads the selected Claude PID session with spawnFile=%s',
    async (spawnFile) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      registerPane(spawnFile)
      const inspection = await new LocalPtyProvider().inspectProcess(ID)
      expect(inspection).toMatchObject({
        foregroundProcess: 'claude',
        agentName: 'Amber Harbor',
        agentPid: AGENT_PID,
        permissionMode: 'plan'
      })
      expect(ptyLastRecognizedForeground.get(ID)?.pid).toBe(AGENT_PID)
      expect(readRows).toHaveBeenCalledTimes(2)
    }
  )
})
