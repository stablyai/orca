import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readRuntimeServeSmokePid,
  runtimeServeSmokeProcessState,
  resolveRuntimeServeSmokeLaunch,
  verifyRuntimeServeSmokeFinalExport
} from './runtime-serve-smoke-launch.mjs'

beforeEach(() => vi.stubEnv('CI', ''))

const roots = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('packaged runtime smoke isolation', () => {
  it('launches the packaged CLI with a prepared, isolated home and no inherited runtime override', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-smoke-launch-'))
    roots.push(root)
    const app = join(root, process.platform === 'darwin' ? 'Orca.app' : 'unpacked')
    vi.stubGlobal('process', { ...process, argv: ['node', 'smoke', `--packaged-app-dir=${app}`] })
    vi.stubEnv('ORCA_APP_EXECUTABLE', '/unrelated/Orca')
    const launch = resolveRuntimeServeSmokeLaunch(root, join(root, 'profile'), 7101)
    const resources =
      process.platform === 'darwin' ? join(app, 'Contents', 'Resources') : join(app, 'resources')
    const name =
      process.platform === 'win32'
        ? 'orca.exe'
        : process.platform === 'darwin'
          ? 'orca'
          : 'orca-ide'
    expect(launch.command).toBe(join(resources, 'bin', name))
    expect(launch.args).toEqual(['serve', '--json', '--port', '7101'])
    expect(launch.ownerLoss).toBe(process.platform === 'win32')
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      expect(statSync(launch.env[key]).isDirectory()).toBe(true)
    }
    expect(launch.env.ORCA_E2E_HOME_DIR).toBe(launch.env.HOME)
    expect(launch.env.ORCA_E2E_USER_DATA_DIR).toBe(join(root, 'profile'))
    expect(launch.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    const env = { ...process.env, ...launch.env }
    expect(env.ORCA_APP_EXECUTABLE).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('launches orcad directly on bundled Bun and retains its lock check', () => {
    vi.stubGlobal('process', { ...process, argv: ['node', 'smoke', '--target', 'orcad'] })
    const launch = resolveRuntimeServeSmokeLaunch('/checkout', '/profile', 7102)
    expect(launch.lockPath).toBe(join('/profile', 'orcad.lock'))
    expect(launch.command).toBe(
      join(
        '/checkout',
        'out',
        'orcad',
        process.platform === 'win32' ? 'bun-runtime.exe' : 'bun-runtime'
      )
    )
    expect(launch.args).toEqual([
      join('/checkout', 'out', 'orcad', 'orcad.js'),
      '--port',
      '7102',
      '--json'
    ])
  })
})

it('requires a completed shutdown export containing the newly created workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-final-export-'))
  roots.push(root)
  const profile = join(root, 'profiles', 'fixture')
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: 'fixture' })
  )
  const verify = () =>
    verifyRuntimeServeSmokeFinalExport(root, 'repo::path::workspace:new-workspace')
  expect(verify).toThrow()
  const dataFile = join(profile, 'orca-data.json')
  writeFileSync(dataFile, JSON.stringify({ folderWorkspaces: [{ id: 'old-workspace' }] }))
  expect(verify).toThrow('Final shutdown export omitted')
  writeFileSync(
    dataFile,
    JSON.stringify({
      repos: [{ id: 'repo', kind: 'folder' }],
      worktreeMeta: { 'repo::path::workspace:new-workspace': { instanceId: 'new-workspace' } }
    })
  )
  expect(verify).not.toThrow()
})

it('limits shutdown diagnostics to a validated PID without metadata credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-smoke-pid-'))
  roots.push(root)
  expect(readRuntimeServeSmokePid(root)).toBeNull()
  const file = join(root, 'orca-runtime.json')
  for (const pid of [-1, 0, '123', null, 1.5]) {
    writeFileSync(file, JSON.stringify({ pid, authToken: 'secret' }))
    expect(readRuntimeServeSmokePid(root)).toBeNull()
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, authToken: 'secret' }))
  expect(readRuntimeServeSmokePid(root)).toBe(process.pid)
  expect(runtimeServeSmokeProcessState(process.pid)).toBe('live')
  expect(runtimeServeSmokeProcessState(null)).toBe('unknown')
})
