import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ReasonixHookService } from './hook-service'
import { createManagedHookLocalFilesystem } from '../agent-hooks/managed-hook-local-filesystem'
import {
  getReasonixConfigPath,
  parseReasonixHookSettings,
  reasonixManagedHookEvents,
  REASONIX_HOOK_EVENTS
} from './hook-settings'

const executionRoot = vi.hoisted(() => vi.fn())
vi.mock('./execution-host-config', () => ({ resolveReasonixExecutionHostConfig: executionRoot }))

let root = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rx-hook-test-'))
  const home = join(root, 'home')
  await mkdir(home)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('REASONIX_HOME', root)
  executionRoot.mockReset()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('preserves user native hooks and unknown settings, installs idempotently, and removes only managed entries', async () => {
  const path = getReasonixConfigPath()
  const userHook = { command: 'printf custom', timeout: 99, env: { CUSTOM: 'kept' } }
  await writeFile(
    path,
    JSON.stringify({
      theme: 'custom',
      hooks: { Stop: [userHook], Notification: [{ command: 'printf notice' }] }
    })
  )
  const service = new ReasonixHookService()
  expect(service.install().state).toBe('installed')
  const installed = parseReasonixHookSettings(await readFile(path, 'utf8'))
  expect(reasonixManagedHookEvents(installed).size).toBe(REASONIX_HOOK_EVENTS.length)
  const unchanged = new Date(1_000)
  await utimes(path, unchanged, unchanged)
  expect(service.install().state).toBe('installed')
  expect((await stat(path)).mtimeMs).toBe(unchanged.getTime())
  expect(service.remove().state).toBe('not_installed')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    theme: 'custom',
    hooks: { Stop: [userHook], Notification: [{ command: 'printf notice' }] }
  })
})

it('refuses malformed settings without overwriting any bytes', async () => {
  const path = getReasonixConfigPath()
  await mkdir(dirname(path), { recursive: true })
  for (const raw of ['{', '{"hooks":{"Stop":[{"hooks":[]}]}}', '{"hooks":[]}']) {
    await writeFile(path, raw)
    expect(new ReasonixHookService().install().state).toBe('error')
    expect(await readFile(path, 'utf8')).toBe(raw)
  }
})

it('installs, reports and removes local hooks in the configuration root of the owning shell', async () => {
  const configHome = join(root, 'owning-shell-config')
  executionRoot.mockResolvedValue(configHome)
  const service = new ReasonixHookService()
  expect(await service.installForExecutionHost()).toMatchObject({
    state: 'installed',
    configPath: join(configHome, 'settings.json')
  })
  expect(service.getStatus().state).toBe('installed')
  await expect(stat(join(root, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await service.removeForExecutionHost()).toMatchObject({ state: 'not_installed' })
})

it.runIf(process.platform !== 'win32')(
  'installs through the remote filesystem into the owning host custom root',
  async () => {
    const configHome = join(root, 'remote-config')
    const home = join(root, 'home')
    await mkdir(configHome)
    const path = join(configHome, 'settings.json')
    await writeFile(path, JSON.stringify({ theme: 'kept', hooks: { Stop: [{ command: 'user' }] } }))
    expect(
      await new ReasonixHookService().installRemote(
        createManagedHookLocalFilesystem(),
        home,
        configHome
      )
    ).toMatchObject({ state: 'installed', configPath: path })
    const settings = parseReasonixHookSettings(await readFile(path, 'utf8'))
    expect(reasonixManagedHookEvents(settings).size).toBe(9)
    expect(settings.theme).toBe('kept')
    expect(settings.hooks).toMatchObject({ Stop: expect.arrayContaining([{ command: 'user' }]) })
    await expect(stat(join(home, '.reasonix'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

it.runIf(process.platform !== 'win32')(
  'refuses malformed remote settings and unsafe roots before config mutation',
  async () => {
    const configHome = join(root, 'remote-config')
    await mkdir(configHome)
    const path = join(configHome, 'settings.json')
    await writeFile(path, '{')
    const service = new ReasonixHookService()
    const filesystem = createManagedHookLocalFilesystem()
    expect(await service.installRemote(filesystem, join(root, 'home'), configHome)).toMatchObject({
      state: 'error'
    })
    expect(await readFile(path, 'utf8')).toBe('{')
    expect(await service.installRemote(filesystem, join(root, 'home'), 'relative')).toMatchObject({
      state: 'error'
    })
    await expect(stat(join(root, 'home', '.orca'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
)
