import { SessionNotFoundError } from '../../daemon/protocol/daemon-errors'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { dispatchSetupGatedPty } from '../../ipc/pty/spawn-required-setup'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it.each([0, 7, null])(
    'retains exact Setup outcome %s captured during spawn, through exit and output eviction',
    async (exitCode) => {
      const runtime = new OrcaRuntimeService(store)
      let ptyId = ''
      runtime.setPtyController({
        spawn: async (options) => {
          ptyId = options.sessionId!
          runtime.onPtyData(ptyId, '__ORCA_SETUP_COMPLETE__:wrong:0\r\n', 100)
          if (exitCode !== null) {
            runtime.onPtyData(
              ptyId,
              `\x1b]777;__ORCA_SETUP_COMPLETE__:token-fast:${exitCode}\x07`,
              101
            )
          }
          runtime.onPtyData(ptyId, 'noise'.repeat(100_000), 102)
          return { id: ptyId }
        },
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        setupCompletionToken: 'token-fast'
      })
      await runtime.onPtyExit(ptyId, 0)
      await expect(runtime.waitForSetupTerminalCompletion(handle)).resolves.toEqual({ exitCode })
      await expect(runtime.waitForSetupTerminalCompletion(handle)).resolves.toEqual({ exitCode })
    }
  )

  it.each([20, 200])(
    'retires required Setup outcomes when %s workspaces are removed',
    async (count) => {
      const runtime = new OrcaRuntimeService(store)
      const base = await runtime.showManagedTerminalWorkspace(`path:${TEST_WORKTREE_PATH}`)
      runtime.setPtyController({
        spawn: async (options) => {
          runtime.onPtyData(options.sessionId!, '__ORCA_SETUP_COMPLETE__:retire:7\r\n', 100)
          return { id: options.sessionId! }
        },
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const ids: string[] = []
      for (let index = 0; index < count; index++) {
        const worktree = {
          ...base,
          id: `repo-1::/tmp/setup-retire-${index}`,
          path: `/tmp/setup-retire-${index}`
        }
        ids.push(worktree.id)
        await runtime.createTerminal(
          `id:${worktree.id}`,
          {
            setupRequired: true,
            setupCompletionToken: 'retire'
          },
          undefined,
          worktree
        )
        await expect(runtime.waitForWorkspaceSetup(worktree.id, 'Codex')).rejects.toThrow()
        runtime.releaseRemovedWorktreeHostSessions(worktree.id, 'worktree-removal')
      }
      for (const id of ids) {
        await expect(runtime.waitForWorkspaceSetup(id, 'Codex')).resolves.toBeUndefined()
      }
    }
  )

  it('returns additional real terminals during required Setup and refuses failed Setup', async () => {
    const runtime = new OrcaRuntimeService(store)
    let setupPtyId = ''
    const spawns: { command?: string; env?: Record<string, string> }[] = []
    runtime.setPtyController({
      spawn: async (options) =>
        dispatchSetupGatedPty(
          {
            args: options,
            spawnOptions: { ...options },
            effectiveSessionAppId: options.sessionId,
            deps: { runtime },
            provider: {
              spawn: async (prepared: typeof options & { attachOnly?: boolean }) => {
                if (prepared.attachOnly) {
                  throw new SessionNotFoundError(prepared.sessionId!)
                }
                spawns.push(prepared)
                if (prepared.env?.ORCA_SEQUENCED_SETUP_SCRIPT) {
                  setupPtyId = prepared.sessionId!
                }
                return { id: prepared.sessionId ?? `dependent-${spawns.length}` }
              }
            }
          } as never,
          () => {}
        ),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const worktree = await runtime.showManagedTerminalWorkspace(`path:${TEST_WORKTREE_PATH}`)
    await runtime.provisionManagedWorktreeTerminals({
      worktreeId: worktree.id,
      worktreeSelector: `id:${worktree.id}`,
      worktreePath: worktree.path,
      setup: { runnerScriptPath: '/tmp/setup.sh', envVars: {}, waitForAgentStartup: true },
      hasStartupTerminal: false,
      setupOnly: true,
      setupCompletionToken: 'additional-gate',
      setupCommandPlatform: 'posix'
    })
    const first = await runtime.createTerminal(`id:${worktree.id}`, {
      command: 'codex',
      sessionId: 'dependent-2',
      env: { ORCA_SEQUENCED_STARTUP_COMMAND: 'forged' }
    })
    const second = await runtime.createTerminal(`id:${worktree.id}`, {
      command: 'claude',
      sessionId: 'dependent-3'
    })
    expect(first.ptyId).toBe('dependent-2')
    expect(second.ptyId).toBe('dependent-3')
    expect(spawns[1]?.env?.ORCA_SEQUENCED_STARTUP_COMMAND).toBe('codex')
    expect(spawns[1]?.command).not.toBe('codex')
    expect(spawns[2]?.command).not.toBe('claude')
    runtime.onPtyData(setupPtyId, '__ORCA_SETUP_COMPLETE__:additional-gate:7\r\n', 100)
    await expect(runtime.createTerminal(`id:${worktree.id}`, { command: 'codex' })).rejects.toThrow(
      'Setup did not finish successfully'
    )
    expect(spawns).toHaveLength(3)
    await runtime.provisionManagedWorktreeTerminals({
      worktreeId: worktree.id,
      worktreeSelector: `id:${worktree.id}`,
      worktreePath: worktree.path,
      setup: { runnerScriptPath: '/tmp/setup.sh', envVars: {}, waitForAgentStartup: true },
      hasStartupTerminal: true,
      setupOnly: true,
      setupCompletionToken: 'retry-gate',
      setupCommandPlatform: 'posix'
    })
    const retry = await runtime.createTerminal(`id:${worktree.id}`, {
      command: 'codex',
      sessionId: 'retry-agent'
    })
    runtime.onPtyData(setupPtyId, '__ORCA_SETUP_COMPLETE__:retry-gate:0\r\n', 101)
    await expect(runtime.waitForTerminalSetup(first.handle, 'codex')).rejects.toThrow(
      'Setup did not finish successfully'
    )
    await expect(runtime.waitForTerminalSetup(retry.handle, 'codex')).resolves.toBeUndefined()
  })

  it('drops retained PTY transcript memory when a background terminal exits', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.onPtyData(
      'pty-bg',
      `${Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')}\nwrote /tmp/exited-result.json\n`,
      100
    )
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'running',
      tail: expect.arrayContaining(['line-0'])
    })

    runtime.onPtyExit('pty-bg', 0)

    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            tailBuffer: string[]
            tailPartialLine: string
            tailLinesTotal: number
            tailTruncated: boolean
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toMatchObject({
      tailBuffer: [],
      tailPartialLine: '',
      tailLinesTotal: 0,
      tailTruncated: false
    })
    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      status: 'exited',
      tail: []
    })
  })

  it('bounds disconnected background PTY records and their synthetic handles', async () => {
    let nextPtyIndex = 0
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockImplementation(async () => ({ id: `pty-bg-${nextPtyIndex++}` })),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const handles: string[] = []
    for (let index = 0; index < 140; index += 1) {
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
      handles.push(handle)
      runtime.onPtyData(`pty-bg-${index}`, `wrote /tmp/result-${index}.json\n`, 100 + index)
      runtime.onPtyExit(`pty-bg-${index}`, 0)
    }

    const internals = runtime as unknown as {
      ptysById: Map<string, unknown>
      handles: Map<string, unknown>
      handleByPtyId: Map<string, string>
    }
    expect(internals.ptysById.size).toBeLessThanOrEqual(128)
    expect(internals.ptysById.has('pty-bg-0')).toBe(false)
    expect(internals.ptysById.has('pty-bg-139')).toBe(true)
    expect(internals.handleByPtyId.has('pty-bg-0')).toBe(false)
    expect(internals.handles.has(handles[0]!)).toBe(false)

    await expect(runtime.readTerminal(handles[0]!)).rejects.toThrow('terminal_handle_stale')
    await expect(runtime.readTerminal(handles.at(-1)!)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('does not treat a Codex launch title as tui-idle readiness', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      const serializeProviderBuffer = vi.fn().mockResolvedValue({
        data: 'OpenAI Codex\r\nmodel: gpt-5.5\r\ndirectory: /repo\r\n',
        cols: 80,
        rows: 24,
        seq: 1
      })
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeProviderBuffer
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      runtime.attachWindow(1)
      await runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-bg',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex YOLO',
            activeLeafId: 'pane-bg',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-bg',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane-bg',
            paneRuntimeId: 1,
            ptyId: 'pty-bg',
            paneTitle: null
          }
        ]
      })

      const waitPromise = runtime.waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: 1_000
      })
      const timeoutAssertion = expect(waitPromise).rejects.toThrow('timeout')

      await vi.advanceTimersByTimeAsync(2_000)

      await timeoutAssertion
      expect(serializeProviderBuffer).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
