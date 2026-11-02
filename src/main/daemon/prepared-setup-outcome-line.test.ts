import './mock-descendant-sweep'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { SETUP_STATUS_FILE_ENV } from '../../shared/observed-setup-launch'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isPreparedAgentLaunchStatus } from '../../shared/prepared-agent-launch'
import { fingerprintPreparedAgentLaunch } from './prepared-agent-launch-payload'
import { HeadlessEmulator } from './headless-emulator'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']
const COLS = 40
const ROWS = 6
const FAILED = 'Setup failed, so Codex was not started. Fix Setup, then start Codex from a new tab.'

describe('the Setup failure line written into a live shell', () => {
  let host: TerminalHost | undefined

  afterEach(async () => {
    await host?.dispose()
  })

  it('lands above the prompt the shell already drew, keeping its typed input and cursor', async () => {
    let emit: (data: string) => void = () => {}
    let statusFile = ''
    const spawnSubprocess = vi.fn<SpawnSubprocess>((opts) => {
      const raw = opts.rawSpawnObserver?.()
      statusFile = opts.env?.[SETUP_STATUS_FILE_ENV] ?? statusFile
      raw?.onSelected()
      let sessionData: (data: string) => void = () => {}
      let exit: (code: number) => void = () => {}
      emit = (data) => sessionData(data)
      return {
        pid: 4242,
        getForegroundProcess: () => null,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => exit(0)),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => exit(137)),
        signal: vi.fn(),
        onData: (cb) => {
          sessionData = cb
        },
        onExit: (cb) => {
          exit = cb
        },
        dispose: vi.fn()
      } as SubprocessHandle
    })
    host = new TerminalHost({ spawnSubprocess })
    const attemptId = randomUUID()
    const payload = {
      launch: { sessionId: 'agent', cols: COLS, rows: ROWS, command: 'codex' },
      setup: {
        spawn: { sessionId: 'setup', cols: COLS, rows: ROWS },
        attemptId,
        deadline: Date.now() + 7_200_000
      }
    }
    const prepared = await host.preparedAgentLaunch({
      action: 'prepare',
      operationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
      fingerprint: fingerprintPreparedAgentLaunch(payload),
      claim: {
        kind: 'fresh-launch',
        agent: 'codex',
        keyId: 'key',
        identityDigest: 'a'.repeat(43),
        worktreeScopeDigest: 'b'.repeat(43),
        digestVersion: 1
      },
      surface: {
        worktreeId: 'wt',
        tabId: 'tab_agent',
        leafId: randomUUID(),
        terminalHandle: 'term_agent'
      }
    })
    if (!isPreparedAgentLaunchStatus(prepared)) {
      throw new Error('missing preparation')
    }
    await host.preparedAgentLaunch({ action: 'accept', identity: prepared, ...payload })
    // Setup is live once its owner has bound the exact session it can write into.
    await vi.waitFor(async () =>
      expect(
        await host!.preparedAgentLaunch({ action: 'status', identity: prepared })
      ).toHaveProperty('setup.incarnationId')
    )

    // Setup fails, and the interactive shell draws its prompt before main's answer arrives.
    emit('npm install\r\nnpm ERR! missing script\r\n')
    writeFileSync(statusFile, `${attemptId}:3\n`)
    await vi.waitFor(async () =>
      expect(
        await host!.preparedAgentLaunch({ action: 'status', identity: prepared })
      ).toMatchObject({ failure: 'setup-failed' })
    )
    emit('$ git sta')
    await expect(
      host.preparedAgentLaunch({ action: 'writeSetupOutcome', identity: prepared, text: FAILED })
    ).resolves.toEqual({ written: true })
    emit('tus')

    const screen = new HeadlessEmulator({ cols: COLS, rows: ROWS })
    const attached = await host.createOrAttach({
      sessionId: 'setup',
      cols: COLS,
      rows: ROWS,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    screen.writeSync(attached.snapshot!.snapshotAnsi)
    const lines = screen.getVisibleLines()
    expect(lines.at(-1)?.trimEnd()).toBe('$ git status')
    expect(lines.slice(-4, -1).join('').trimEnd()).toBe(`[orca] ${FAILED}`)
    screen.dispose()
  })
})
