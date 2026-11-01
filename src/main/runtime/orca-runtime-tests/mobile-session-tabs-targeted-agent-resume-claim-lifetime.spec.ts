import { describe, expect, it } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { TEST_WORKTREE_ID } from '../orca-runtime-test-fixtures.spec'
import { deterministicAgentSessionUuid } from '../runtime-agent-launch-resolution'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../remote-runtime-terminal-create-identity'
import {
  PANE_KEY,
  MUTATION_ID,
  makeSleptWorkspace,
  makeRuntime,
  sessionRow,
  resumeSpawns,
  storedRecord
} from './targeted-agent-resume.test-fixture'

describe('resumeAgentSessionInWorkspace retries, cancellation and a failed publication', () => {
  it('reconciles the same request after its own hook arrives', async () => {
    let rows: AgentStatusIpcPayload[] = []
    const terminalHandle = deriveRemoteRuntimeTerminalCreateHandle(
      'agent-session-resume',
      TEST_WORKTREE_ID,
      MUTATION_ID
    )
    const { resume, spawn } = makeRuntime(makeSleptWorkspace(), {
      rows: () => rows,
      checkHookAgentPresence: async () => 'live',
      listProcesses: async () =>
        spawn.mock.calls.length > 0
          ? [
              {
                id: 'resumed-pty',
                cwd: '',
                title: 'claude',
                terminalHandle,
                worktreeId: TEST_WORKTREE_ID
              }
            ]
          : []
    })
    const first = await resume()
    if (!first.ok) {
      throw new Error(first.reason)
    }
    rows = [sessionRow(first.paneKey, Date.now() + 1)]
    await expect(resume()).resolves.toEqual(first)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('honors cancellation during create inventory lookup before dispatch', async () => {
    const controller = new AbortController()
    const { resume, spawn } = makeRuntime(makeSleptWorkspace(), {
      listProcesses: async () => {
        controller.abort()
        return []
      }
    })
    await expect(resume({ signal: controller.signal })).resolves.toMatchObject({ ok: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('settles a failed post-spawn publication when that PTY exits', async () => {
    const { runtime, resume } = makeRuntime(makeSleptWorkspace())
    const unsubscribe = runtime.onMobileSessionTabsChanged(() => {
      throw new Error('publication failed')
    })
    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    unsubscribe()
    runtime.onPtyExit('resumed-pty', 0)
    await expect(resume({ mutationId: 'next-delivery' })).resolves.toMatchObject({ ok: true })
  })
})

describe('resumeAgentSessionInWorkspace claim lifetime', () => {
  it('releases the hold after a proven exit before registration', async () => {
    let first = true
    const { runtime, resume } = makeRuntime(makeSleptWorkspace(), {
      spawn: async () => {
        if (first) {
          first = false
          runtime.beginPtyRegistration('resumed-pty')
          runtime.onPtyExit('resumed-pty', 0)
        }
        return { id: 'resumed-pty' }
      }
    })
    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    await expect(resume({ mutationId: 'after-proven-exit' })).resolves.toMatchObject({ ok: true })
  })

  it('does not settle a lost reply using another caller terminal in the same pane', async () => {
    let rejectFirst!: (error: Error) => void
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    let calls = 0
    const { runtime, resume, spawn } = makeRuntime(makeSleptWorkspace(), {
      spawn: async () => {
        calls += 1
        if (calls === 1) {
          started()
          return new Promise<{ id: string }>((_resolve, reject) => {
            rejectFirst = reject
          })
        }
        return { id: `other-pty-${calls}` }
      }
    })
    const first = resume()
    await start
    const args = spawn.mock.calls[0]?.[0]
    if (
      !args ||
      typeof args !== 'object' ||
      !('tabId' in args) ||
      !('leafId' in args) ||
      typeof args.tabId !== 'string' ||
      typeof args.leafId !== 'string'
    ) {
      throw new Error('missing pane identity')
    }
    const other = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: args.tabId,
      leafId: args.leafId,
      command: 'echo another caller',
      focus: false
    })
    rejectFirst(new Error('lost spawn reply'))
    await expect(first).resolves.toEqual({ ok: false, reason: 'create_failed' })
    if (!other.ptyId) {
      throw new Error('missing other PTY')
    }
    runtime.onPtyExit(other.ptyId, 0)
    await expect(resume({ mutationId: 'other-delivery' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })
  })

  it('does not settle an ambiguous resume using an earlier exited shell in its pane', async () => {
    const seed = `${TEST_WORKTREE_ID}\0${MUTATION_ID}`
    const tabId = deterministicAgentSessionUuid(`agent-session-resume-tab\0${seed}`)
    const leafId = deterministicAgentSessionUuid(`agent-session-resume-leaf\0${seed}`)
    let firstInventory = true
    let spawns = 0
    const { runtime, resume } = makeRuntime(makeSleptWorkspace(), {
      listProcesses: async () => {
        if (firstInventory) {
          firstInventory = false
          const other = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
            tabId,
            leafId,
            command: 'echo another caller',
            focus: false
          })
          if (!other.ptyId) {
            throw new Error('missing shell PTY')
          }
          runtime.onPtyExit(other.ptyId, 0)
        }
        return []
      },
      spawn: async () => {
        spawns += 1
        if (spawns === 2) {
          throw new Error('resume started but reply lost')
        }
        return { id: `sequential-pty-${spawns}` }
      }
    })
    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    await expect(resume({ mutationId: 'next-delivery' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })
  })
})

it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'hands a numbered-record resume claim to the stable pane hook',
  async () => {
    const fixture = makeSleptWorkspace()
    const record = storedRecord(fixture)
    if (!record) {
      throw new Error('missing sleep record')
    }
    fixture.setSession({
      ...fixture.getSession(),
      sleepingAgentSessionsByPaneKey: {
        'host-tab:1': { ...record, paneKey: 'host-tab:1', state: 'done' }
      }
    })
    let rows: AgentStatusIpcPayload[] = []
    let spawned = 0
    const { resume, openOldPane, spawn } = makeRuntime(fixture, {
      rows: () => rows,
      checkHookAgentPresence: async () => 'exited',
      spawn: async () => ({ id: `numbered-resume-${++spawned}` })
    })
    await openOldPane()
    expect(resumeSpawns(spawn)).toBe(1)
    rows = [sessionRow(PANE_KEY, Date.now() + 1)]
    await expect(resume()).resolves.toMatchObject({ ok: true })
  }
)
