import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../../../../../shared/orca-profiles/constants'

import '../../../../runtime/terminal/stop/worktree-sleep-resume-records'
import '../../../../native-chat/transcript-filesystem/ssh-transcript-path'
import '../../../../native-chat/transcript-discovery/native-chat-open-wake'
import '../../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live')
}))

let home: string
let server: AgentHookServer
let stopping: boolean
let placed: boolean
const read = () => server.getStatusSnapshotForPane(PANE)[0]

beforeEach(async () => {
  _internals.resetCachesForTests()
  home = mkdtempSync(join(tmpdir(), 'orca-sleep-status-'))
  stopping = false
  placed = true
  server = new AgentHookServer()
  server.setTerminalPaneLifecycle({
    ownsProcess: (_key, pty, incarnation) => pty === 'pty' && incarnation === 'birth',
    isStopping: () => stopping,
    isReversibleStop: (pty, incarnation) => stopping && pty === 'pty' && incarnation === 'birth',
    isPlaced: () => placed
  })
  await server.start({ env: 'production', userDataPath: home })
})

afterEach(() => {
  server.stop()
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
})

it('accepts a genuine providerless completion after stop intent and preserves it through transport loss', () => {
  const publish = (state: 'working' | 'done') =>
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: 'ssh-host',
      payload: { state, prompt: 'Custom task', agentType: 'unknown' }
    })
  publish('working')
  stopping = true
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(false)
  publish('done')
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'other-birth')).toBe(false)
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
  server.clearStatusEntriesForConnection('ssh-host')
  expect(read()).toMatchObject({ state: 'done', paneSleep: { ptyId: 'pty' } })
  server.retireSleepingPaneOnSpawn(PANE)
  expect(read()).toBeUndefined()
})

it('does not restore a sleeping status whose exact placed pane is absent', async () => {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    payload: { state: 'done', prompt: 'Custom task', agentType: 'unknown' }
  })
  stopping = true
  expect(server.settleTerminalPaneSleep(PANE, 'pty', 'birth')).toBe(true)
  server.stop()
  placed = false
  await server.start({ env: 'production', userDataPath: home })
  expect(read()).toBeUndefined()
})
