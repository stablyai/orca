import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../shared/single-instance-exit-code'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('child_process', () => ({ spawn: spawnMock }))

import { serveOrcaApp } from './launch'

/** Why: the Electron main's single-instance rule sits past a pre-JS abort on macOS (STA-4336) — assert the CLI decides before the exec. */
describe('serveOrcaApp duplicate refusal', () => {
  let userDataPath: string
  let stderrSpy: ReturnType<typeof vi.spyOn>
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let endpointCount = 0
  const servers = new Set<Server>()
  const sockets = new Set<Socket>()

  beforeEach(async () => {
    spawnMock.mockReset()
    userDataPath = await mkdtemp(join(tmpdir(), 'orca-serve-duplicate-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
    process.env.ORCA_APP_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const socket of sockets) {
      socket.destroy()
    }
    sockets.clear()
    await Promise.all(
      [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    servers.clear()
    delete process.env.ORCA_USER_DATA_PATH
    delete process.env.ORCA_APP_EXECUTABLE
    await rm(userDataPath, { recursive: true, force: true })
  })

  function writtenJson(spy: ReturnType<typeof vi.spyOn>): unknown {
    return JSON.parse(spy.mock.calls.map((call) => String(call[0])).join(''))
  }

  function nextEndpoint(): { kind: 'unix' | 'named-pipe'; endpoint: string } {
    endpointCount += 1
    return process.platform === 'win32'
      ? { kind: 'named-pipe', endpoint: `\\\\.\\pipe\\orca-dup-${process.pid}-${endpointCount}` }
      : { kind: 'unix', endpoint: join(userDataPath, `owner-${endpointCount}.sock`) }
  }

  async function writeMetadata(transport: { kind: string; endpoint: string }): Promise<void> {
    await writeFile(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-owner',
        pid: process.pid,
        transports: [transport],
        authToken: 'token',
        startedAt: Date.now()
      })
    )
  }

  /** A socket that accepts but never answers is the shape of a serve still initialising. */
  async function startSilentOwner(): Promise<void> {
    const transport = nextEndpoint()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(transport.endpoint, resolve))
    await writeMetadata(transport)
  }

  it('refuses without spawning when the profile already has a live owner', async () => {
    await startSilentOwner()

    await expect(serveOrcaApp()).resolves.toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('not starting a second process'))
  })

  // Why: `--json` callers parse stdout; a prose-only refusal is indistinguishable
  // to them from a serve that produced no output at all.
  it('reports the refusal as a machine-readable envelope for --json', async () => {
    await startSilentOwner()

    await expect(serveOrcaApp({ json: true })).resolves.toBe(
      SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(writtenJson(stdoutSpy)).toMatchObject({
      ok: false,
      error: {
        code: 'runtime_serve_already_running',
        data: { pid: process.pid, evidence: 'listening' }
      }
    })
  })

  // Why: recipe stdout carries only a schema-valid recipe result, so the envelope would
  // corrupt it. `--json` is a global flag, so both can be set on one invocation.
  it('refuses recipe-json runs without writing anything to the recipe stdout channel', async () => {
    await startSilentOwner()

    await expect(
      serveOrcaApp({ json: true, recipeJson: true, projectRoot: '/workspace/repo' })
    ).resolves.toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('not starting a second process'))
  })

  it('does not refuse a profile whose runtime left its metadata behind', async () => {
    // Why: the recorded pid is this very test process, so a pid-based rule would
    // read the crashed runtime as alive and refuse every serve on this profile
    // forever. Only a socket that still accepts proves an owner.
    await writeMetadata(nextEndpoint())
    spawnMock.mockReturnValue({ on: vi.fn(), once: vi.fn(), unref: vi.fn(), kill: vi.fn() })

    void serveOrcaApp({ json: true })

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
  })

  it('still spawns when no runtime owns the profile', async () => {
    spawnMock.mockReturnValue({ on: vi.fn(), once: vi.fn(), unref: vi.fn(), kill: vi.fn() })

    void serveOrcaApp({ json: true })

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
  })
})
