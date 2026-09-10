import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockDispatcher, createTestPtyHandler } from './pty-handler-test-harness'
import { RelayAgentHookRuntime } from './relay-agent-hook-runtime'
import type { RelayAgentHookServer } from './agent-hook-server'
import type { RelayDispatcher } from './dispatcher'
import type { ProviderResourceDiagnosticResult } from '../shared/provider-resource-diagnostics'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('node-pty', () => ({ spawn }))
vi.mock('../main/pty/posix-pty-process-groups', () => ({ forceKillPosixPtyProcessGroups: vi.fn() }))

describe('relay production launch and hook diagnostic ingress', () => {
  it('retains a normalized SessionStart beyond pane-cache retirement and serves only diagnostic correspondence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-resource-relay-'))
    const transcriptPath = join(root, 'synthetic.jsonl')
    await writeFile(transcriptPath, '{}\n')
    let exit: ((event: { exitCode: number }) => void) | undefined
    const proc = {
      pid: process.pid,
      onData: vi.fn(),
      onExit: (cb: typeof exit) => {
        exit = cb
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn()
    }
    spawn.mockReturnValue(proc)
    const dispatcher = Object.assign(createMockDispatcher(), { activeClientIds: () => [] })
    const handler = createTestPtyHandler(dispatcher)
    const runtime = new RelayAgentHookRuntime(
      dispatcher as unknown as RelayDispatcher,
      handler,
      join(root, 'socket'),
      join(root, 'hooks')
    )
    const paneKey = 'synthetic-tab:11111111-1111-4111-8111-111111111111'
    try {
      await runtime.start()
      handler.addEnvAugmenter(() => ({ CLAUDE_CONFIG_DIR: root }))
      const created = (await dispatcher.callRequest('pty.spawn', {
        cols: 80,
        rows: 24,
        cwd: root,
        env: {
          ORCA_PROVIDER_RESOURCE_DIAGNOSTICS: '1',
          ORCA_PANE_KEY: paneKey,
          ORCA_AGENT_LAUNCH_TOKEN: 'synthetic-launch',
          CLAUDE_CONFIG_DIR: '/unresolved-client-default'
        }
      })) as { id: string; incarnationId: string }
      const server = (runtime as unknown as { hookServer: RelayAgentHookServer }).hookServer
      const coordinates = server.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${coordinates.port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': coordinates.token
        },
        body: JSON.stringify({
          paneKey,
          tabId: 'synthetic-tab',
          env: 'remote',
          version: '1',
          launchToken: 'synthetic-launch',
          payload: {
            hook_event_name: 'SessionStart',
            source: 'startup',
            session_id: 'synthetic-session',
            transcript_path: transcriptPath
          }
        })
      })
      expect(response.status).toBe(204)
      const query = (path = transcriptPath) =>
        dispatcher.callRequest('pty.providerResourceDiagnostic', {
          kind: 'query',
          query: {
            requestId: 'request-a',
            agent: 'claude',
            transcriptPath: path,
            sessionId: 'synthetic-session'
          }
        }) as Promise<ProviderResourceDiagnosticResult>
      await expect.poll(async () => (await query()).facts?.objectObserved).toBe(true)
      server.clearPaneState(paneKey)
      const alias = join(root, 'alias.jsonl')
      await link(transcriptPath, alias)
      const result = await query(alias)
      expect(result.facts).toMatchObject({
        rootResolved: true,
        reportedSessionMatches: true,
        lifecycleBound: false,
        pty: { id: created.id, incarnationId: created.incarnationId, verdict: 'live' }
      })
      expect(result.verdict).toBe('unverifiable')
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(proc.write).not.toHaveBeenCalled()
      expect(await dispatcher.callRequest('pty.getCapabilities')).toMatchObject({
        providerResourceDiagnosticVersion: 1
      })
    } finally {
      exit?.({ exitCode: 0 })
      runtime.stop()
      await handler.dispose({ waitForPhysicalExit: false })
      await rm(root, { recursive: true, force: true })
    }
  })
})
