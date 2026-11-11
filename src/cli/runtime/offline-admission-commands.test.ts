import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { readAgentHookSettingsFromProfileState } from '../../main/persistence/profile-state/profile-state-offline-settings'
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
function settings() {
  return readAgentHookSettingsFromProfileState({
    dataFile: join(profile, 'orca-data.json'),
    databaseFile: join(profile, 'profile-state.db'),
    profileId: 'fixture'
  })
}
function output() {
  return JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))
}
async function refusedEndpoint() {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(endpoint, resolve))
  renameSync(endpoint, `${endpoint}.stale`)
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  renameSync(`${endpoint}.stale`, endpoint)
}

describe.skipIf(process.platform === 'win32')(
  'offline CLI admission through dispatch and persistence',
  () => {
    it.each(['complete', 'singular', 'incomplete', 'refused'])(
      'recovers JSON and toggles hooks both ways with %s stopped metadata',
      async (shape) => {
        metadata(shape)
        if (shape === 'refused') {
          await refusedEndpoint()
        }
        await main(['profile', 'state', 'rollback', '--current-json', '--json'], root)
        expect(process.exitCode).toBe(0)
        expect(output()).toMatchObject({ ok: true, result: { storage: 'json' } })
        expect(JSON.parse(readFileSync(join(profile, 'orca-data.json'), 'utf8'))).toMatchObject({
          retained: { value: 7 }
        })
        for (const enabled of [true, false]) {
          await main(['agent', 'hooks', enabled ? 'on' : 'off', '--json'], root)
          expect(process.exitCode).toBe(0)
          expect(output()).toMatchObject({
            ok: true,
            result: {
              enabled,
              appliedBy: 'offline',
              statuses: [expect.objectContaining({ agent: 'claude', managedHooksPresent: enabled })]
            }
          })
          expect(settings().agentStatusHooksEnabled).toBe(enabled)
          const config = JSON.parse(
            readFileSync(join(root, 'HOME', '.claude', 'settings.json'), 'utf8')
          )
          expect(JSON.stringify(config.hooks ?? {}).includes('orca')).toBe(enabled)
        }
      }
    )

    it('refuses a visible PID without creating a database or changing profile and hook files', async () => {
      metadata('complete', process.pid)
      const before = readFileSync(join(profile, 'orca-data.json'))
      for (const args of [
        ['profile', 'state', 'rollback', '--current-json'],
        ['agent', 'hooks', 'on'],
        ['agent', 'hooks', 'off']
      ]) {
        process.exitCode = 0
        await main([...args, '--json'], root)
        expect(process.exitCode).toBe(1)
        expect(output()).toMatchObject({ ok: false, error: { code: 'runtime_error' } })
        expect(readFileSync(join(profile, 'orca-data.json'))).toEqual(before)
        expect(existsSync(join(profile, 'profile-state.db'))).toBe(false)
        expect(existsSync(join(root, 'HOME', '.claude'))).toBe(false)
      }
    })

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
