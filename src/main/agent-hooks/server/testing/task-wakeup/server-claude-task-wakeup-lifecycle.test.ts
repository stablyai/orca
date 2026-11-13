import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../../../../wsl-guest/agent-hook-server'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { createRuntimeAutomationRunTerminalObserver } from '../../../../automations/observation/runtime-terminal-run-observer'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../../../runtime/orca-runtime-tests/agent-transcript-pane-test-harness'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

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

describe.each([false])('real automation Claude wake-up oracle remote=%s', (remote) => {
  it.each(['missing-notification', 'native-idle', 'notification-before-launch'])(
    'waits on captured ready bytes through task finishing or missing wake-up expiry: %s',
    async (ending) => {
      const server = await host(remote, 'transcript-launch')
      const controller = new AbortController()
      const ready = readFileSync(
        join(import.meta.dirname, '../../../../runtime/__fixtures__/claude-ready-task-wakeup.txt'),
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
