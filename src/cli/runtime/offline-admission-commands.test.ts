import '../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import type * as ProcessHost from '@orca/process-host'
import { main } from '../index'

const { runChild } = vi.hoisted(() => ({ runChild: vi.fn() }))
vi.mock('@orca/process-host', async (original) => ({
  ...(await original<typeof ProcessHost>()),
  runProcess: runChild
}))

// Exercise the existing hook installer on one isolated target; do not discover installed agents.
vi.mock('../../main/agent-hooks/installation/managed-agent-hook-controls', async () => {
  const { claudeHookService } = await import('../../main/claude/hook-service.js')
  return {
    applyAgentStatusHooksEnabled: vi.fn(async (enabled: boolean) => [
      enabled ? claudeHookService.install({ claudeVersion: '2.1.0' }) : claudeHookService.remove()
    ]),
    getManagedAgentHookStatuses: () => [claudeHookService.getStatus()]
  }
})

const priorExit = process.exitCode
const sockets = new Set<Socket>()
let root: string
let profile: string
let endpoint: string
let server: ReturnType<typeof createServer> | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-offline-command-'))
  profile = join(root, 'profiles', 'fixture')
  endpoint = join(root, 'runtime.sock')
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: 'fixture', profiles: [{ id: 'fixture' }] })
  )
  writeFileSync(
    join(profile, 'orca-data.json'),
    JSON.stringify({ settings: { agentStatusHooksEnabled: false }, retained: { value: 7 } })
  )
  for (const key of [
    'ORCA_PAIRING_CODE',
    'ORCA_REMOTE_PAIRING',
    'ORCA_ENVIRONMENT',
    'ELECTRON_RUN_AS_NODE',
    'ORCA_APP_EXECUTABLE',
    'WSL_DISTRO_NAME'
  ]) {
    vi.stubEnv(key, undefined)
  }
  for (const key of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR'
  ]) {
    vi.stubEnv(key, join(root, key))
  }
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  setAppEnvironment({
    getPath: () => root,
    getAppPath: () => root,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  runChild.mockReset()
  process.exitCode = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  if (server) {
    const listening = server
    await new Promise<void>((resolve) => listening.close(() => resolve()))
  }
  server = undefined
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = priorExit
  rmSync(root, { recursive: true, force: true })
})

function metadata(shape = 'complete', pid = 2147483647) {
  writeFileSync(
    join(root, 'orca-runtime.json'),
    JSON.stringify({
      runtimeId: 'runtime-before',
      pid,
      authToken: shape === 'incomplete' ? null : 'fixture-token',
      startedAt: 1,
      ...(shape === 'singular'
        ? { transport: { kind: 'unix', endpoint } }
        : { transports: [{ kind: 'unix', endpoint }] })
    })
  )
}

describe.skipIf(process.platform === 'win32')(
  'offline CLI admission through dispatch and persistence',
  () => {
    it.each(['close', 'server-error'])(
      'never replays a failed online settings update offline (%s)',
      async (failure) => {
        metadata()
        const methods: string[] = []
        const listener = createServer((socket) => {
          sockets.add(socket)
          socket.once('close', () => sockets.delete(socket))
          socket.once('data', (data) => {
            const request = JSON.parse(String(data))
            methods.push(request.method)
            if (request.method === 'settings.update' && failure === 'close') {
              socket.end()
              return
            }
            socket.end(
              `${JSON.stringify({
                id: request.id,
                ...(request.method === 'status.get'
                  ? {
                      ok: true,
                      result: {
                        runtimeId: 'runtime-before',
                        graphStatus: 'ready',
                        authoritativeWindowId: null
                      }
                    }
                  : {
                      ok: false,
                      error: { code: 'runtime_unavailable', message: 'update rejected' }
                    }),
                _meta: { runtimeId: 'runtime-before' }
              })}\n`
            )
          })
        })
        server = listener
        await new Promise<void>((resolve) => listener.listen(endpoint, resolve))
        const before = readFileSync(join(profile, 'orca-data.json'))
        await main(['agent', 'hooks', 'on', '--json'], root)
        expect(process.exitCode).toBe(1)
        expect(methods).toEqual(['status.get', 'settings.update'])
        expect(readFileSync(join(profile, 'orca-data.json'))).toEqual(before)
        expect(existsSync(join(profile, 'profile-state.db'))).toBe(false)
        expect(existsSync(join(root, 'HOME', '.claude'))).toBe(false)
      }
    )
  }
)
