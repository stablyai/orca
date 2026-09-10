import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtySubprocess } from './pty-subprocess'
import { mockPtyProcess } from './pty-subprocess-test-harness'
import { DaemonServer } from './daemon-server'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn }))
vi.mock('../providers/local-pty-utils', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validateWorkingDirectoryAsync: async () => {},
  resolveUnixShellPath: (shell: string) => shell
}))
vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: async () => ({
    available: true,
    processName: null
  })
}))
vi.mock('../pty/posix-pty-process-groups', () => ({ forceKillPosixPtyProcessGroups: vi.fn() }))

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('native final-spawn diagnostic metadata', () => {
  it('delivers a retained final-launch match through the authenticated daemon JSON route', async () => {
    const root = await mkdtemp(join(process.cwd(), '.pr-'))
    const transcriptPath = join(root, 'synthetic.jsonl')
    await writeFile(transcriptPath, '{}\n')
    const proc = mockPtyProcess(process.pid)
    spawn.mockReturnValue(proc)
    const socketPath = join(root, 'socket')
    const tokenPath = join(root, 'token')
    const server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: createPtySubprocess })
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    const harness = { server, adapter }
    try {
      await server.start()
      const created = await harness.adapter.spawn({
        cols: 80,
        rows: 24,
        cwd: root,
        shellOverride: '/bin/sh',
        env: {
          ORCA_PROVIDER_RESOURCE_DIAGNOSTICS: '1',
          ORCA_PANE_KEY: 'synthetic-pane',
          ORCA_AGENT_LAUNCH_TOKEN: 'synthetic-launch',
          CLAUDE_CONFIG_DIR: root
        }
      })
      await harness.adapter.providerResourceDiagnostic({
        kind: 'hook',
        hook: {
          paneKey: 'synthetic-pane',
          launchToken: 'synthetic-launch',
          hookEventName: 'SessionStart',
          providerSession: { id: 'synthetic-session', transcriptPath }
        }
      })
      const query = {
        kind: 'query' as const,
        query: {
          requestId: 'request-a',
          agent: 'claude',
          transcriptPath,
          sessionId: 'synthetic-session'
        }
      }
      await expect
        .poll(
          async () =>
            (await harness.adapter.providerResourceDiagnostic(query))?.facts?.objectObserved
        )
        .toBe(true)
      const result = await harness.adapter.providerResourceDiagnostic(query)
      expect(result?.facts?.pty).toMatchObject({
        id: created.id,
        incarnationId: created.incarnationId,
        verdict: 'live'
      })
      expect(result?.verdict).toBe('unverifiable')
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(proc.write).not.toHaveBeenCalled()
    } finally {
      proc._simulateExit(0)
      harness.adapter.dispose()
      await harness.server.shutdown()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('retains only allowlisted fields from the actual environment passed to node-pty', async () => {
    spawn.mockReturnValue(mockPtyProcess())
    const handle = await createPtySubprocess({
      sessionId: 'synthetic-pty',
      cols: 80,
      rows: 24,
      shellOverride: '/bin/sh',
      env: {
        ORCA_PROVIDER_RESOURCE_DIAGNOSTICS: '1',
        ORCA_PANE_KEY: 'synthetic-pane',
        ORCA_AGENT_LAUNCH_TOKEN: 'synthetic-launch',
        CLAUDE_CONFIG_DIR: '/synthetic/root',
        UNRELATED_VALUE: 'do-not-retain'
      }
    })
    const finalEnv = spawn.mock.calls[0]![2].env
    expect(handle.providerResourceLaunch).toEqual({
      ORCA_PROVIDER_RESOURCE_DIAGNOSTICS: finalEnv.ORCA_PROVIDER_RESOURCE_DIAGNOSTICS,
      ORCA_PANE_KEY: finalEnv.ORCA_PANE_KEY,
      ORCA_AGENT_LAUNCH_TOKEN: finalEnv.ORCA_AGENT_LAUNCH_TOKEN,
      CLAUDE_CONFIG_DIR: finalEnv.CLAUDE_CONFIG_DIR
    })
    expect(handle.providerResourceLaunch).not.toHaveProperty('UNRELATED_VALUE')
    handle.dispose()
  })

  it('leaves ordinary non-opted-in spawns without retained diagnostic metadata', async () => {
    vi.stubEnv('ORCA_PROVIDER_RESOURCE_DIAGNOSTICS', '0')
    spawn.mockReturnValue(mockPtyProcess())
    const handle = await createPtySubprocess({
      sessionId: 'synthetic-pty',
      cols: 80,
      rows: 24,
      shellOverride: '/bin/sh'
    })
    expect(handle.providerResourceLaunch).toBeUndefined()
    handle.dispose()
  })
})
