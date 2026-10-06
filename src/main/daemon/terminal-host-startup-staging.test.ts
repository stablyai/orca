import './mock-descendant-sweep'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

let tempDir: string
let exitSubprocess: ((code: number) => void) | undefined

function mockSubprocess(shellPath: string): SubprocessHandle {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handle stubs only what session creation calls.
  return {
    pid: 1,
    shellPath,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: (callback: (code: number) => void) => {
      exitSubprocess = callback
    },
    dispose: vi.fn()
  } as SubprocessHandle
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-daemon-staging-'))
  vi.stubEnv('TMPDIR', tempDir)
  exitSubprocess = undefined
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tempDir, { recursive: true, force: true })
})

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('daemon startup command staging', () => {
  async function create(command: string, shellPath = '/bin/zsh') {
    const sub = mockSubprocess(shellPath)
    const host = new TerminalHost({ spawnSubprocess: () => sub })
    const result = await host.createOrAttach({
      sessionId: `s-${command.length}`,
      cols: 80,
      rows: 24,
      command,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    return { sub, result }
  }

  it('types a short launch line and reports it typed', async () => {
    const { sub, result } = await create(`claude 'fix it'`)
    expect(sub.write).toHaveBeenCalledWith(`claude 'fix it'\r`)
    expect(result.isNew).toBe(true)
  })

  it('types only a sourcing line for a launch past 512 bytes', async () => {
    const command = `claude '${'x'.repeat(600)}'`
    const { sub, result } = await create(command)
    const [script] = readdirSync(tempDir)
    expect(script).toMatch(/^orca-launch-[0-9a-f]+\.sh$/)
    const scriptPath = join(tempDir, script)
    expect(sub.write).toHaveBeenCalledWith(`. '${scriptPath}'\r`)
    expect(readFileSync(scriptPath, 'utf8').split('\n')[1]).toBe(command)
    expect(result).not.toHaveProperty('startupDelivery')
  })

  it('stages a multi-line launch instead of bracket-pasting it', async () => {
    const { sub } = await create(`claude 'one\ntwo'`)
    expect(vi.mocked(sub.write).mock.calls[0][0]).toMatch(/^\. '.*orca-launch-[0-9a-f]+\.sh'\r$/)
  })

  it('deletes a script the shell never sourced when the session exits', async () => {
    await create(`claude '${'x'.repeat(600)}'`)
    const scriptPath = join(tempDir, readdirSync(tempDir)[0])
    exitSubprocess?.(0)
    expect(existsSync(scriptPath)).toBe(false)
  })

  it('types nothing when there is no startup command', async () => {
    const sub = mockSubprocess('/bin/zsh')
    const host = new TerminalHost({ spawnSubprocess: () => sub })
    await host.createOrAttach({
      sessionId: 's-none',
      cols: 80,
      rows: 24,
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(sub.write).not.toHaveBeenCalled()
  })

  // Why (stack QA P8-2): typed in full, a long agent line left the shell at a quote prompt, the
  // prompt lost while agent.launch reported success; refusing hands the user the prompt instead.
  // A temp folder that looks writable and still fails the write is that race.
  it('refuses an agent launch whose staging write failed in a usable-looking folder', async () => {
    const notAFolder = join(tempDir, 'file')
    writeFileSync(notAFolder, '')
    vi.stubEnv('TMPDIR', notAFolder)
    const sub = mockSubprocess('/bin/zsh')
    vi.mocked(sub.forceKill).mockImplementation(() => exitSubprocess?.(1))
    vi.mocked(sub.kill).mockImplementation(() => exitSubprocess?.(1))
    const host = new TerminalHost({ spawnSubprocess: () => sub })
    await expect(
      host.createOrAttach({
        sessionId: 's-agent-stage-failed',
        cols: 80,
        rows: 24,
        command: `claude '${'x'.repeat(600)}'`,
        launchAgent: 'claude',
        shellReadySupported: false,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow(/launch_file_unavailable/)
    expect(sub.write).not.toHaveBeenCalled()
    expect(host.listSessions().map((session) => session.sessionId)).not.toContain(
      's-agent-stage-failed'
    )
  })

  // Why (stack QA 2a): main's delivery for an unusable folder is the line typed as is; refusing it
  // made a 5-line prompt worse than main.
  it('types an agent line as is when the temp folder is unusable', async () => {
    vi.stubEnv('TMPDIR', join(tempDir, 'missing'))
    const command = `claude 'one\ntwo'`
    const sub = mockSubprocess('/bin/zsh')
    const host = new TerminalHost({ spawnSubprocess: () => sub })
    const result = await host.createOrAttach({
      sessionId: 's-agent-folder-unusable',
      cols: 80,
      rows: 24,
      command,
      launchAgent: 'claude',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    expect(result.isNew).toBe(true)
    expect(sub.write).toHaveBeenCalledWith(`claude 'one\rtwo'\r`)
  })

  it('prints a notice in the terminal when it types a line it could not stage', async () => {
    vi.stubEnv('TMPDIR', join(tempDir, 'missing'))
    const command = `claude '${'x'.repeat(600)}'`
    const onData = vi.fn()
    const sub = mockSubprocess('/bin/zsh')
    const host = new TerminalHost({ spawnSubprocess: () => sub })
    await host.createOrAttach({
      sessionId: 's-stage-failed',
      cols: 80,
      rows: 24,
      command,
      shellReadySupported: false,
      streamClient: { onData, onExit: vi.fn() }
    })
    expect(sub.write).toHaveBeenCalledWith(`${command}\r`)
    await vi.waitFor(() => {
      expect(onData.mock.calls.map(([data]) => String(data)).join('')).toContain(
        '[orca] Could not stage the launch command (ENOENT'
      )
    })
  })
})
