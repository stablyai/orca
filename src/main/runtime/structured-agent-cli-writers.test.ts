import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AgentProcessVerdict } from '../../shared/agent-process-presence'
import type { CliWriterObservation } from '../agent-hooks/server/cli-writer-observation'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import {
  assertCliConversationWritersExited,
  type CliWriterHost
} from './structured-agent-cli-writers'
import { OrcaRuntimeService } from './orca-runtime'
import {
  OPEN_CODE_WRITER_TOPOLOGY,
  tmuxCliWriterEvent
} from '../agent-hooks/server/cli-writer-observation'

const snapshot = vi.hoisted(() => vi.fn())
vi.mock('../../shared/process-table-snapshot-reader', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFreshShellForegroundSnapshot: snapshot
}))
const probe = vi.hoisted(() => vi.fn())
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const row: AgentStatusIpcPayload = {
  paneKey: 'source',
  worktreeId: 'workspace',
  connectionId: null,
  agentType: 'codex',
  receivedAt: 1,
  stateStartedAt: 1,
  state: 'done',
  prompt: '',
  providerSession: { key: 'session_id', id: 'conversation' }
}
function inspection(verdict: AgentProcessVerdict | null = null) {
  let current = true
  let identity = 'original-pty'
  const observation: CliWriterObservation = {
    current: () => current,
    topology: 'pane-owned',
    presence: vi.fn(async () => verdict)
  }
  const host: CliWriterHost = {
    rows: () => [row],
    saved: () => [],
    observation: () => observation,
    sleeping: () => false,
    terminal: () => ({ pane: { ptyId: 'pty', incarnationId: identity, identity } }),
    links: () => [],
    shellAlone: vi.fn(async () => true)
  }
  return {
    host,
    observation,
    replaceRow: () => {
      current = false
    },
    replacePty: () => {
      identity = 'replacement-pty'
    },
    run: () => assertCliConversationWritersExited(host, 'codex', 'conversation')
  }
}
const refusal = {
  refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
}

beforeEach(() => vi.clearAllMocks())
describe('execution-host conversation writer inspection', () => {
  it('accepts exact exited or unchanged shell-only proof, never loss of evidence', async () => {
    await expect(inspection('unverifiable').run()).rejects.toMatchObject(refusal)
    for (const cause of ['missing-row', 'sleeping', 'failed-scan', 'unknown-topology'] as const) {
      const check = inspection()
      if (cause === 'missing-row') {
        check.host.observation = () => null
      }
      if (cause === 'sleeping') {
        check.host.sleeping = () => true
      }
      if (cause === 'failed-scan') {
        check.host.rows = () => {
          throw new Error('unavailable')
        }
      }
      if (cause === 'unknown-topology') {
        check.observation.topology = 'unverifiable'
      }
      await expect(check.run()).rejects.toMatchObject(refusal)
    }
  })

  it('refuses replaced conversation observations or terminal incarnations across awaits', async () => {
    for (const replace of ['row', 'pty'] as const) {
      const check = inspection('exited')
      check.observation.presence = async () => {
        if (replace === 'row') {
          check.replaceRow()
        } else {
          check.replacePty()
        }
        return 'exited'
      }
      await expect(check.run()).rejects.toMatchObject(refusal)
    }
  })

  it('requires current owned shell proof for saved resumes, including done checkpoints', async () => {
    const record: SleepingAgentSessionRecord = {
      paneKey: 'source',
      worktreeId: 'workspace',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'conversation' },
      prompt: '',
      state: 'done',
      origin: 'live',
      capturedAt: 1,
      updatedAt: 1
    }
    const check = inspection('exited')
    let saved = [record]
    check.host.saved = () => saved
    check.host.rows = () => []
    check.host.sleeping = () => true
    await expect(check.run()).rejects.toMatchObject(refusal)
    check.host.sleeping = () => false
    const terminal = check.host.terminal
    check.host.terminal = () => ({ pane: null })
    await expect(check.run()).rejects.toMatchObject(refusal)
    check.host.terminal = terminal
    await expect(check.run()).resolves.toBeUndefined()
    await expect(
      assertCliConversationWritersExited(
        { ...check.host, saved: () => [{ ...record, agent: 'opencode2' }] },
        'opencode',
        'conversation'
      )
    ).rejects.toMatchObject(refusal)
    saved = [{ ...record, connectionId: 'ssh-A' }]
    await expect(check.run()).resolves.toBeUndefined()
    saved = [record]
    check.host.rows = () => [{ ...row, providerSession: { key: 'session_id', id: 'other' } }]
    await expect(check.run()).rejects.toMatchObject(refusal)
    check.host.rows = () => [row]
    await expect(check.run()).resolves.toBeUndefined()
    expect(check.host.shellAlone).toHaveBeenCalledTimes(2)
    check.host.shellAlone = async () => {
      saved = []
      return true
    }
    await expect(check.run()).rejects.toMatchObject(refusal)
    saved = [record]
    check.host.shellAlone = async () => {
      check.replacePty()
      return true
    }
    await expect(check.run()).rejects.toMatchObject(refusal)
    const newlySaved = inspection()
    newlySaved.host.saved = () => saved
    saved = []
    newlySaved.host.shellAlone = async () => {
      saved = [record]
      return true
    }
    await expect(newlySaved.run()).rejects.toMatchObject(refusal)
    const noRows = inspection()
    noRows.host.saved = () => saved
    noRows.host.rows = () => []
    noRows.host.shellAlone = async () => {
      noRows.host.rows = () => [
        { ...row, connectionId: 'ssh-A', providerSession: undefined, structuredHost: 'owned' }
      ]
      return true
    }
    await expect(noRows.run()).rejects.toMatchObject(refusal)
    noRows.host.rows = () => []
    noRows.host.shellAlone = async () => {
      record.providerSession.transcriptPath = 'changed'
      return true
    }
    await expect(noRows.run()).rejects.toMatchObject(refusal)
    noRows.host.shellAlone = async () => {
      noRows.replacePty()
      return true
    }
    await expect(noRows.run()).rejects.toMatchObject(refusal)
  })

  it('inspects the terminal a conversation leaves, whatever its rows now say', async () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    const pane = `tab-a:${leaf}`
    let rows: AgentStatusIpcPayload[] = []
    const runtime = new OrcaRuntimeService(null, undefined, {
      getAgentProviderSessionSnapshot: () => rows,
      readHookCliWriterObservation: () => ({
        current: () => true,
        topology: 'pane-owned',
        presence: async () => null
      })
    })
    const register = (tabId: string, incarnationId?: string, isWsl?: boolean) =>
      runtime.registerPty('pty', 'workspace', null, { tabId, leafId: leaf, incarnationId }, isWsl)
    register('tab-a', 'i1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only listProcesses.
    runtime.setPtyController({
      listProcesses: async () => [{ id: 'pty', rootProcessId: 10, incarnationId: 'i1' }]
    } as never)
    const event = (agentType: string, extra?: Partial<EnrichedAgentHookEventPayload>) => ({
      paneKey: pane,
      connectionId: null,
      receivedAt: 1,
      stateStartedAt: 1,
      providerSession: { key: 'session_id' as const, id: 'conversation' },
      payload: { state: 'done' as const, prompt: '', agentType },
      ...extra
    })
    const report = (agentType: string, extra?: Partial<EnrichedAgentHookEventPayload>) =>
      runtime.recordCliWriterConversation(event(agentType, extra))
    const check = (
      agent: 'claude' | 'opencode',
      source?: { workspaceId: string; paneKey: string }
    ) => runtime.assertStructuredAdoptionTerminalWritersExited(agent, 'conversation', source)
    const shell = { pid: 10, ppid: 1, stat: 'Ss+', command: '/bin/zsh' }
    const census = async (run: () => Promise<void>) => {
      // A prompt's zpty worker left the session; any suspended or background job counts, whatever its name.
      const worker = [
        shell,
        { pid: 20, ppid: 10, stat: 'Ss+', command: '-zsh -i' },
        { pid: 21, ppid: 20, stat: 'S+', command: 'git status' }
      ]
      for (const stat of ['T', 'SN']) {
        snapshot.mockResolvedValue([...worker, { pid: 22, ppid: 10, stat, command: 'agent-alias' }])
        await expect(run()).rejects.toMatchObject(refusal)
      }
      snapshot.mockResolvedValue(worker)
      await expect(run()).resolves.toBeUndefined()
    }
    // The header switch inspects the pane it leaves even when nothing recorded the conversation.
    await census(() => check('claude', { workspaceId: 'workspace', paneKey: pane }))
    // A row restored after restart has no observed identity; the pane's current PTY decides.
    rows = [{ ...row, paneKey: pane, agentType: 'claude' }]
    await census(() => check('claude'))
    rows = []
    // Paused, then a second run overwrote the row and the pane moved: the link is the execution's.
    report('claude')
    report('claude', { providerSession: { key: 'session_id', id: 'later-run' } })
    register('tab-b', 'i1')
    await census(() => check('claude'))
    // The agent's own process can outlive the terminal's tree, as in detached tmux or nohup.
    report('claude', {
      agentPresence: { agent: 'claude', process: { pid: 12, platform: 'darwin', startTime: 's' } }
    })
    for (const verdict of ['live', 'unverifiable', 'exited'] as const) {
      probe.mockResolvedValueOnce(verdict)
      const result = expect(check('claude'))
      await (verdict === 'exited'
        ? result.resolves.toBeUndefined()
        : result.rejects.toMatchObject(refusal))
    }
    // An unmarked binding copy keeps a proven pane-owned link; an uninspectable PTY or tmux refuses.
    const proven = { key: 'session_id' as const, id: 'conversation' }
    Object.defineProperty(proven, OPEN_CODE_WRITER_TOPOLOGY, { value: 'pane-owned' })
    report('opencode2', { providerSession: proven })
    report('opencode2')
    await census(() => check('opencode'))
    register('tab-b', undefined, true)
    await expect(check('opencode')).rejects.toMatchObject(refusal)
    register('tab-b', undefined, false)
    runtime.recordCliWriterConversation(tmuxCliWriterEvent(event('opencode2')))
    await expect(check('opencode')).rejects.toMatchObject(refusal)
    // A new incarnation is a new execution: the old one's links died with it.
    register('tab-b', 'i2')
    await expect(check('opencode')).resolves.toBeUndefined()
  })
})
