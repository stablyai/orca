// Run the real bundle, stdio mux, installers, and HTTP ingest using node in place of wsl.exe.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { AgentHookServer } from './server'
import { WslHookRelayManager } from './wsl-hook-relay-manager'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem.test-fixture'
import { codexHookService } from '../codex/hook-service'

const BUNDLE_DIR = join(process.cwd(), 'out', 'relay', 'wsl')
const BUNDLE_JS = join(BUNDLE_DIR, 'wsl-agent-hook-relay.js')
const LEAF = '11111111-1111-4111-8111-111111111111'

async function pickFreePort(): Promise<number> {
  const probe = createServer()
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

// Guest home semantics require POSIX; Windows needs a real WSL distro.
describe.skipIf(process.platform === 'win32')(
  'WSL hook relay live host chain (real bundle over real child stdio)',
  () => {
    let fakeHome: string
    let manager: WslHookRelayManager | null
    let orcaServer: AgentHookServer | null
    let child: ChildProcessWithoutNullStreams | null

    beforeAll(() => {
      if (!existsSync(BUNDLE_JS)) {
        execFileSync(process.execPath, [join('config', 'scripts', 'build-wsl-guest.mjs')], {
          cwd: process.cwd(),
          stdio: 'ignore'
        })
      }
    }, 120_000)

    afterEach(() => {
      manager?.disposeAll()
      orcaServer?.stop()
      child?.kill()
      rmSync(fakeHome, { recursive: true, force: true })
    })

    it('delivers a Claude hook POST from the live relay into ingestRemote and installs guest hooks', async () => {
      fakeHome = mkdtempSync(join('/tmp', 'wsl-live-home-'))
      const preferredPort = await pickFreePort()
      const version = readFileSync(join(BUNDLE_DIR, '.version'), 'utf8').trim()

      orcaServer = new AgentHookServer()
      const events: { paneKey: string; payload: unknown; connectionId: string | null }[] = []
      orcaServer.setListener((event) => {
        events.push({
          paneKey: event.paneKey,
          payload: event.payload,
          connectionId: event.connectionId
        })
      })
      const server = orcaServer

      const warns: string[] = []
      const codexHome = join(fakeHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
      manager = new WslHookRelayManager({
        platform: () => 'win32',
        remoteHooksEnabled: () => true,
        hookCoordsEnv: () => ({
          ORCA_AGENT_HOOK_PORT: String(preferredPort),
          ORCA_AGENT_HOOK_TOKEN: 'live-token',
          ORCA_AGENT_HOOK_ENV: 'production',
          ORCA_AGENT_HOOK_VERSION: '1'
        }),
        instanceKey: () => 'liveinstance',
        resolveBundle: () => ({ jsPath: BUNDLE_JS, version }),
        listDistros: async () => ['LiveDistro'],
        spawnRelay: (_distro, env) => {
          child = spawn(process.execPath, [BUNDLE_JS], {
            env: { ...env, HOME: fakeHome },
            stdio: ['pipe', 'pipe', 'pipe']
          }) as ChildProcessWithoutNullStreams
          return child
        },
        runInstall: async () => {
          throw new Error('guest install must not run for a direct node spawn')
        },
        ingest: (envelope, connectionId) =>
          server.ingestRemote(
            envelope as Parameters<AgentHookServer['ingestRemote']>[0],
            connectionId
          ),
        installCodex: (runtimeHomePath) =>
          codexHookService.installRemote(createManagedHookLocalFilesystem(), fakeHome, {
            codexHomeDir: runtimeHomePath,
            deferTrustUntilConfigToml: true
          }),
        managedHookSettings: () => ({
          agentCmdOverrides: {
            claude: process.execPath,
            codex: process.execPath
          }
        }),
        warn: (message) => warns.push(message),
        transientRetryDelayMs: 1
      })

      manager.ensureForDistro('LiveDistro', codexHome)

      // Wait for Codex rather than the earlier Claude artifact so the installer loop reaches this assertion.
      await vi.waitFor(() => expect(existsSync(join(codexHome, 'hooks.json'))).toBe(true), {
        timeout: 15_000
      })
      await vi.waitFor(
        () => expect(existsSync(join(fakeHome, '.claude', 'settings.json'))).toBe(true),
        { timeout: 15_000 }
      )
      const claudeScript = readFileSync(
        join(fakeHome, '.orca', 'agent-hooks', 'claude-hook.sh'),
        'utf8'
      )
      expect(claudeScript).toContain('/hook/claude')

      expect(existsSync(join(codexHome, 'config.toml'))).toBe(false)
      expect(existsSync(join(fakeHome, '.codex', 'hooks.json'))).toBe(false)

      // Read the actual endpoint because the preferred port may have been occupied.
      const endpointFile = join(
        fakeHome,
        '.orca-wsl',
        'agent-hooks',
        'instance-liveinstance',
        'endpoint.env'
      )
      expect(existsSync(endpointFile)).toBe(true)
      const endpointText = readFileSync(endpointFile, 'utf8')
      const port = Number(/ORCA_AGENT_HOOK_PORT=['"]?(\d+)/.exec(endpointText)?.[1])
      const token = /ORCA_AGENT_HOOK_TOKEN=['"]?([A-Za-z0-9-]+)/.exec(endpointText)?.[1]
      expect(port).toBeGreaterThan(0)
      expect(token).toBe('live-token')

      const paneKey = `tab-live:${LEAF}`
      const postClaude = async (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': token ?? ''
          },
          body: JSON.stringify({
            paneKey,
            tabId: 'tab-live',
            worktreeId: 'wt-live',
            env: 'remote',
            version: '1',
            payload
          })
        })

      const promptRes = await postClaude({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'live roundtrip'
      })
      expect(promptRes.status).toBe(204)
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000 })
      expect(events[0].paneKey).toBe(paneKey)
      expect(events[0].connectionId).toBe('wsl:LiveDistro')
      const working = events[0].payload as { state: string; prompt: string; agentType: string }
      expect(working.state).toBe('working')
      expect(working.prompt).toBe('live roundtrip')
      expect(working.agentType).toBe('claude')

      const stopRes = await postClaude({ hook_event_name: 'Stop' })
      expect(stopRes.status).toBe(204)
      await vi.waitFor(
        () => {
          const done = events.find((e) => (e.payload as { state?: string }).state === 'done')
          expect(done).toBeTruthy()
        },
        { timeout: 10_000 }
      )

      // Link death must schedule recovery before later hook events disappear into a dead mux.
      child?.kill()
      await vi.waitFor(
        () => expect(warns.some((w) => w.includes('scheduling restart'))).toBe(true),
        { timeout: 10_000 }
      )
    }, 40_000)
  }
)
