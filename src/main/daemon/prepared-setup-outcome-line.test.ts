import './mock-descendant-sweep'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { SETUP_STATUS_FILE_ENV } from '../../shared/observed-setup-launch'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPreparedAgentLaunchStatus } from '../../shared/prepared-agent-launch'
import { fingerprintPreparedAgentLaunch } from './prepared-agent-launch-payload'
import { HeadlessEmulator } from './headless-emulator'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']
// Only Date is faked, starting at a fixed instant and still advancing: the host, its timers and the
// Setup it watches run on real time, while the launch's deadline and operation id are fixed.
const NOW = 1_800_000_000_000
const COLS = 40
const ROWS = 6
const FAILED = 'Setup failed, so Codex was not started. Fix Setup, then start Codex from a new tab.'

describe('the Setup failure line written into a live shell', () => {
  let host: TerminalHost | undefined

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW, shouldAdvanceTime: true })
  })
  afterEach(async () => {
    await host?.dispose()
    vi.useRealTimers()
  })

  /** A prepared Setup in a fake shell, failed with exit 3 and bound to the session main writes into. */
  async function failedSetup() {
    let emit: (data: string) => void = () => {}
    let statusFile = ''
    const spawnSubprocess = vi.fn<SpawnSubprocess>((opts) => {
      const raw = opts.rawSpawnObserver?.()
      statusFile = opts.env?.[SETUP_STATUS_FILE_ENV] ?? statusFile
      raw?.onSelected()
      let sessionData: (data: string) => void = () => {}
      let exit: (code: number) => void = () => {}
      emit = (data) => sessionData(data)
      const handle: SubprocessHandle = {
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
      }
      return handle
    })
    host = new TerminalHost({ spawnSubprocess })
    const attemptId = randomUUID()
    const payload = {
      launch: { sessionId: 'agent', cols: COLS, rows: ROWS, command: 'codex' },
      setup: {
        spawn: { sessionId: 'setup', cols: COLS, rows: ROWS },
        attemptId,
        deadline: NOW + 7_200_000
      }
    }
    const prepared = await host.preparedAgentLaunch({
      action: 'prepare',
      operationId: `${NOW}-${randomUUID().replaceAll('-', '')}`,
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
    emit('npm install\r\nnpm ERR! missing script\r\n')
    writeFileSync(statusFile, `${attemptId}:3\n`)
    await vi.waitFor(async () =>
      expect(
        await host!.preparedAgentLaunch({ action: 'status', identity: prepared })
      ).toMatchObject({ failure: 'setup-failed' })
    )
    const write = () =>
      host!.preparedAgentLaunch({ action: 'writeSetupOutcome', identity: prepared, text: FAILED })
    const screen = async () => {
      const attached = await host!.createOrAttach({
        sessionId: 'setup',
        cols: COLS,
        rows: ROWS,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      const emulator = new HeadlessEmulator({ cols: COLS, rows: ROWS })
      emulator.writeSync(attached.snapshot!.snapshotAnsi)
      const lines = emulator.getVisibleLines()
      emulator.dispose()
      return lines
    }
    return { emit, write, screen }
  }

  it('lands above the prompt the shell already drew, keeping its typed input and cursor', async () => {
    const setup = await failedSetup()
    // The interactive shell draws its prompt before main's answer arrives.
    setup.emit('$ git sta')
    await expect(setup.write()).resolves.toEqual({ written: true })
    setup.emit('tus')

    const lines = await setup.screen()
    expect(lines.at(-1)?.trimEnd()).toBe('$ git status')
    expect(lines.slice(-4, -1).join('').trimEnd()).toBe(`[orca] ${FAILED}`)
  })

  it('declines a typed line that wraps, so main shows its toast and the input stays whole', async () => {
    const setup = await failedSetup()
    const typed = `$ ${'a'.repeat(50)}`
    setup.emit(typed)
    await expect(setup.write()).resolves.toEqual({ written: false })
    // A repeat after a lost reply gets the same answer and still writes nothing.
    await expect(setup.write()).resolves.toEqual({ written: false })

    const lines = await setup.screen()
    expect(lines.join('\n')).not.toContain('[orca]')
    const drawn = lines.map((line) => line.trimEnd()).filter(Boolean)
    expect(drawn.slice(-2).join('')).toBe(typed)
  })

  it('declines while a program owns the alternate screen, so the explanation is not lost with it', async () => {
    const setup = await failedSetup()
    setup.emit('$ vim notes\r\n\x1b[?1049h\x1b[HEDITOR')
    await expect(setup.write()).resolves.toEqual({ written: false })
    setup.emit('\x1b[?1049l$ ')

    expect((await setup.screen()).join('\n')).not.toContain('[orca]')
  })
})
