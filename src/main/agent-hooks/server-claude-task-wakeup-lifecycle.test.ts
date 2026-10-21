import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { AgentHookServer, _internals } from './server'
import { createRuntimeAutomationRunTerminalObserver } from '../automations/runtime-terminal-run-observer'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../runtime/agent-transcript-pane-test-harness'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

type CapturedHook = { scenario: string; kind: string; payload?: Record<string, unknown> }
const hooks: CapturedHook[] = readFileSync(
  join(import.meta.dirname, '../../shared/__fixtures__/claude-task-notification-hooks.jsonl'),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const SESSION = '00000000-0000-4000-8000-000000000000'

beforeEach(() => {
  _internals.resetCachesForTests()
})
afterEach(() => vi.useRealTimers())

async function host(remote: boolean, launchToken?: string) {
  const desktop = new AgentHookServer()
  const dir = mkdtempSync(join(tmpdir(), 'orca-task-wakeup-'))
  const relay = remote
    ? new RelayAgentHookServer({
        endpointDir: dir,
        forward: (envelope) => desktop.ingestRemote(envelope, 'ssh-owner')
      })
    : null
  const unsubscribeInterrupt = relay
    ? desktop.subscribeRemoteInterruptRequests(({ request }) => relay.inferInterrupt(request))
    : null
  await desktop.start({ env: 'production' })
  await relay?.start({ publishEndpoint: false })
  const post = async (payload: Record<string, unknown>) => {
    const body = buildBody({ session_id: SESSION, ...payload }, { launchToken })
    const response = relay
      ? await fetch(`http://127.0.0.1:${relay.getCoordinates().port}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Advancing fake time can expire a pooled HTTP socket before the next post.
            Connection: 'close',
            'X-Orca-Agent-Hook-Token': relay.getCoordinates().token
          },
          body: JSON.stringify(body)
        })
      : await postHookEvent(desktop, body)
    expect(response.status).toBe(204)
  }
  const row = () => desktop.getStatusSnapshotForPane(PANE)[0]
  const stop = () => {
    unsubscribeInterrupt?.()
    relay?.stop()
    desktop.stop()
    rmSync(dir, { recursive: true, force: true })
  }
  return { desktop, post, row, stop }
}

describe.each([false, true])('Claude wake-up production ingress remote=%s', (remote) => {
  it.each(['Agent', 'Bash', 'Monitor'])(
    'rejects a blank %s launch without phantom debt',
    async (tool) => {
      const server = await host(remote)
      try {
        await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'launch' })
        await server.post({
          hook_event_name: 'PostToolUse',
          tool_name: tool,
          tool_response:
            tool === 'Agent'
              ? { isAsync: true, agentId: ' \t ' }
              : tool === 'Monitor'
                ? { taskId: ' \t ' }
                : { backgroundTaskId: ' \t ' }
        })
        if (tool === 'Agent') {
          await server.post({ hook_event_name: 'SubagentStop', agent_id: ' \t ' })
        }
        await server.post({ hook_event_name: 'Stop', background_tasks: [] })
        expect(server.row()?.state).toBe('done')
        expect(server.row()?.claudeTaskWakeupPending).toBeUndefined()
      } finally {
        server.stop()
      }
    }
  )

  it.each(['Agent', 'Bash', 'Monitor'])(
    'matches a padded %s launch to its canonical wake-up',
    async (tool) => {
      const server = await host(remote)
      try {
        await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'launch' })
        await server.post({
          hook_event_name: 'PostToolUse',
          tool_name: tool,
          tool_response:
            tool === 'Agent'
              ? { isAsync: true, agentId: ' a1 ' }
              : tool === 'Monitor'
                ? { taskId: ' a1 ' }
                : { backgroundTaskId: ' a1 ' }
        })
        await server.post({
          hook_event_name: 'Stop',
          background_tasks: [
            { id: 'a1', type: tool === 'Agent' ? 'subagent' : 'shell', status: 'running' }
          ]
        })
        expect(server.row()?.claudeTaskWakeupPending).toBeUndefined()
        await server.post(
          tool === 'Agent'
            ? { hook_event_name: 'SubagentStop', agent_id: 'a1' }
            : { hook_event_name: 'Stop', background_tasks: [] }
        )
        expect(server.row()?.claudeTaskWakeupPending).toBe('notification')
        await server.post({
          hook_event_name: 'UserPromptSubmit',
          prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
        })
        expect(server.row()?.claudeTaskWakeupPending).toBe('finishing-turn')
        await server.post({ hook_event_name: 'Stop', background_tasks: [] })
        expect(server.row()?.state).toBe('done')
      } finally {
        server.stop()
      }
    }
  )

  it.each([
    'one-subagent',
    'two-subagents-together',
    'subagent-resumed',
    'subagent-with-own-shell',
    'two-shells-together'
  ])('%s never exposes completion before the final captured wake-up', async (scenario) => {
    const server = await host(remote)
    const records = hooks.filter((record) => record.scenario === scenario && record.payload)
    const finalWakeup = records.findLastIndex(
      (record) =>
        record.payload?.hook_event_name === 'UserPromptSubmit' &&
        String(record.payload.prompt).startsWith('<task-notification>')
    )
    expect(finalWakeup).toBeGreaterThan(0)
    const prematureCompletion: number[] = []
    try {
      for (const [index, record] of records.entries()) {
        await server.post(record.payload!)
        const row = server.row()
        if (index < finalWakeup && row?.state === 'done' && !row.sessionBoundary) {
          prematureCompletion.push(index)
        }
      }
      // Every status subscriber must avoid a false whole-pane completion.
      expect(prematureCompletion).toEqual([])
      expect(server.row()).toMatchObject({
        state: 'done',
        connectionId: remote ? 'ssh-owner' : null
      })
    } finally {
      server.stop()
    }
  })

  it('does not reopen notification debt for a duplicate child-end post', async () => {
    const server = await host(remote)
    try {
      await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
      await server.post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
      await server.post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: { isAsync: true, agentId: 'a1' }
      })
      await server.post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      await server.post({
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
      })
      await server.post({ hook_event_name: 'Stop', background_tasks: [] })
      expect(server.row()?.state).toBe('done')
      await server.post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      expect(server.row()?.state).toBe('done')
      await server.post({
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
      })
      expect(server.row()?.claudeTaskWakeupPending).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it('accepts a delayed wake-up and waits for its main-agent finishing turn', async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout']
    })
    const server = await host(remote)
    try {
      await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate then finish' })
      await server.post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
      await server.post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: { isAsync: true, agentId: 'a1' }
      })
      await server.post({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
      })
      await server.post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      vi.advanceTimersByTime(5_000)
      expect(server.row()?.state).toBe('working')
      await server.post({
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
      })
      vi.advanceTimersByTime(120_000)
      expect(server.row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      await server.post({ hook_event_name: 'Stop', background_tasks: [] })
      expect(server.row()?.state).toBe('done')
    } finally {
      server.stop()
    }
  })
})

describe.each([false, true])('Claude cancellation with an owed wake-up remote=%s', (remote) => {
  it.each([false, true])(
    'keeps cancellation bounded unless a new prompt opens a turn: %s',
    async (newTurn) => {
      vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout']
      })
      const server = await host(remote)
      try {
        await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
        await server.post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
        await server.post({
          hook_event_name: 'PostToolUse',
          tool_name: 'Agent',
          tool_response: { isAsync: true, agentId: 'a1' }
        })
        await server.post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
        const baseline = server.row()!
        expect(
          server.desktop.inferInterrupt({
            paneKey: PANE,
            baselineUpdatedAt: baseline.receivedAt,
            baselineStateStartedAt: baseline.stateStartedAt,
            baselinePrompt: baseline.prompt,
            baselineAgentType: 'claude',
            intent: 'ctrl-c'
          })
        ).toBe(true)
        expect(server.row()).toMatchObject({
          mainAgent: { state: 'done', outcome: 'cancellation' }
        })
        await server.post({
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_response: { content: 'late result' }
        })
        if (newTurn) {
          await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'start a fresh turn' })
        }
        vi.advanceTimersByTime(120_000)
        if (newTurn) {
          expect(server.row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
          expect(server.row()?.mainAgent).not.toHaveProperty('outcome')
          await server.post({ hook_event_name: 'Stop', background_tasks: [] })
          vi.advanceTimersByTime(60_000)
          expect(server.row()?.state).toBe('done')
        } else {
          expect(server.row()).toMatchObject({
            state: 'done',
            interrupted: true,
            mainAgent: { state: 'done', outcome: 'cancellation' }
          })
        }
      } finally {
        server.stop()
      }
    }
  )
})

describe.each([false, true])('real automation Claude wake-up oracle remote=%s', (remote) => {
  it.each([
    'stop',
    'missing-notification',
    'native-idle',
    'cancel',
    'duplicate',
    'shell-duplicate',
    'end-before-launch',
    'notification-before-launch',
    'notification-before-end'
  ])(
    'waits on captured ready bytes through task finishing or missing wake-up expiry: %s',
    async (ending) => {
      const server = await host(remote, 'transcript-launch')
      const controller = new AbortController()
      const ready = readFileSync(
        join(import.meta.dirname, '../runtime/__fixtures__/claude-ready-task-wakeup.txt'),
        'utf8'
      )
      const pane = await createTranscriptPane(
        {
          paneTitle: 'Terminal',
          foregroundProcess: 'claude',
          data: '',
          launchAgent: 'claude',
          ...(remote ? { connectionId: 'ssh-owner' } : {})
        },
        { getAgentStatusSnapshot: () => server.desktop.getStatusSnapshot() }
      )
      const observer = createRuntimeAutomationRunTerminalObserver(pane.runtime)
      const settled = vi.fn()
      vi.useFakeTimers({
        shouldAdvanceTime: true,
        toFake: [
          'Date',
          'performance',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval'
        ]
      })
      try {
        await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate then finish' })
        const earlyDelivery = ending.startsWith('notification-before-')
        const watch = () => {
          const watching = observer.observeCompletion(pane.handle, { signal: controller.signal })
          void watching.then(settled, () => {})
        }
        if (!earlyDelivery) {
          watch()
          await vi.advanceTimersByTimeAsync(300)
        } else {
          pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, ready, Date.now())
          await vi.advanceTimersByTimeAsync(1)
        }
        const shell = ending === 'shell-duplicate'
        const notification = {
          hook_event_name: 'UserPromptSubmit',
          prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
        }
        const reordered = [
          'end-before-launch',
          'notification-before-launch',
          'notification-before-end'
        ].includes(ending)
        if (!shell) {
          await server.post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
        }
        if (ending === 'notification-before-end') {
          await server.post(notification)
        }
        if (reordered) {
          await server.post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
        }
        if (ending === 'notification-before-launch') {
          await server.post(notification)
        }
        await server.post({
          hook_event_name: 'PostToolUse',
          tool_name: shell ? 'Bash' : 'Agent',
          tool_response: shell ? { backgroundTaskId: 'a1' } : { isAsync: true, agentId: 'a1' }
        })
        if (ending !== 'cancel' && !ending.startsWith('notification-before-')) {
          await server.post({
            hook_event_name: 'Stop',
            background_tasks: reordered
              ? []
              : [{ id: 'a1', type: shell ? 'shell' : 'subagent', status: 'running' }]
          })
        }
        if (!reordered) {
          await server.post(
            shell
              ? { hook_event_name: 'Stop', background_tasks: [] }
              : { hook_event_name: 'SubagentStop', agent_id: 'a1' }
          )
        }
        if (ending === 'cancel') {
          const baseline = server.row()!
          expect(
            server.desktop.inferInterrupt({
              paneKey: PANE,
              baselineUpdatedAt: baseline.receivedAt,
              baselineStateStartedAt: baseline.stateStartedAt,
              baselinePrompt: baseline.prompt,
              baselineAgentType: 'claude',
              intent: 'ctrl-c'
            })
          ).toBe(true)
        }
        expect(server.row()?.mainAgent?.state).toBe(
          ending.startsWith('notification-before-') ? 'working' : 'done'
        )
        if (earlyDelivery) {
          watch()
        } else {
          pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, ready, Date.now())
        }
        await vi.advanceTimersByTimeAsync(100)
        expect(settled).not.toHaveBeenCalled()
        if (ending === 'missing-notification' || ending === 'cancel') {
          await vi.advanceTimersByTimeAsync(59_000)
          expect(settled).not.toHaveBeenCalled()
          await vi.advanceTimersByTimeAsync(4_200)
          expect(server.row()?.state).toBe('done')
        } else {
          await server.post({
            hook_event_name: 'UserPromptSubmit',
            prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
          })
          await server.post({
            hook_event_name: 'UserPromptSubmit',
            prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
          })
          await vi.advanceTimersByTimeAsync(120_000)
          expect(settled).not.toHaveBeenCalled()
          expect(server.row()?.claudeTaskWakeupPending).toBe('finishing-turn')
          if (ending === 'native-idle') {
            pane.runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, ready, Date.now())
          } else {
            await server.post({ hook_event_name: 'Stop', background_tasks: [] })
            if (ending === 'duplicate' || ending === 'shell-duplicate') {
              await server.post({
                hook_event_name: 'UserPromptSubmit',
                prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
              })
              expect(server.row()?.claudeTaskWakeupPending).toBeUndefined()
            }
          }
          await vi.advanceTimersByTimeAsync(2_100)
        }
        expect(settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
        if (ending === 'missing-notification') {
          await server.post({
            hook_event_name: 'UserPromptSubmit',
            prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
          })
          expect(server.row()?.claudeTaskWakeupPending).toBe('finishing-turn')
          await server.post({ hook_event_name: 'Stop', background_tasks: [] })
          expect(server.row()?.claudeTaskWakeupPending).toBeUndefined()
        }
      } finally {
        controller.abort()
        server.stop()
      }
    }
  )
})

describe('Claude finishing turn permission restoration', () => {
  it.each(['lead', 'child'])(
    'retains the cycle through a %s question and clears it on Stop or a fresh prompt',
    async (owner) => {
      const server = await host(false)
      try {
        await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
        await server.post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
        await server.post({
          hook_event_name: 'PostToolUse',
          tool_name: 'Agent',
          tool_response: { isAsync: true, agentId: 'a1' }
        })
        await server.post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
        await server.post({
          hook_event_name: 'UserPromptSubmit',
          prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
        })
        expect(server.row()?.claudeTaskWakeupPending).toBe('finishing-turn')
        const child = owner === 'child' ? { agent_id: 'child-question' } : {}
        await server.post({
          hook_event_name: 'PreToolUse',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'question',
          ...child
        })
        expect(server.row()).toMatchObject({
          state: 'waiting',
          claudeTaskWakeupPending: 'finishing-turn'
        })
        const baseline = server.row()!
        expect(
          server.desktop.inferQuestionAnswered({
            paneKey: PANE,
            baselineUpdatedAt: baseline.receivedAt,
            baselineStateStartedAt: baseline.stateStartedAt,
            baselinePrompt: baseline.prompt,
            baselineAgentType: 'claude'
          })
        ).toBe(true)
        await server.post({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: {} })
        expect(server.row()).toMatchObject({
          mainAgent: { state: 'working' },
          claudeTaskWakeupPending: 'finishing-turn'
        })
        if (owner === 'lead') {
          await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'a fresh typed turn' })
          expect(server.row()?.claudeTaskWakeupPending).toBeUndefined()
        }
        await server.post({ hook_event_name: 'Stop', background_tasks: [] })
        expect(server.row()?.claudeTaskWakeupPending).toBeUndefined()
      } finally {
        server.stop()
      }
    }
  )

  it('pairs a sticky child permission with the current lead cycle instead of retaining a stale phase', async () => {
    const server = await host(false)
    try {
      await server.post({ hook_event_name: 'UserPromptSubmit', prompt: 'delegate' })
      await server.post({ hook_event_name: 'SubagentStart', agent_id: 'a1' })
      await server.post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: { isAsync: true, agentId: 'a1' }
      })
      await server.post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
      await server.post({
        hook_event_name: 'UserPromptSubmit',
        prompt: '<task-notification><task-id>a1</task-id><status>completed</status>'
      })
      await server.post({
        hook_event_name: 'PermissionRequest',
        agent_id: 'b1',
        tool_name: 'Bash',
        tool_use_id: 'child-tool'
      })
      await server.post({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: {} })
      expect(server.row()).toMatchObject({
        state: 'waiting',
        claudeTaskWakeupPending: 'finishing-turn',
        mainAgent: { state: 'working' }
      })
      await server.post({
        hook_event_name: 'Stop',
        background_tasks: [{ id: 'b1', type: 'subagent', status: 'running' }]
      })
      expect(server.row()).toMatchObject({ state: 'waiting', mainAgent: { state: 'done' } })
      expect(server.row()?.claudeTaskWakeupPending).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})
