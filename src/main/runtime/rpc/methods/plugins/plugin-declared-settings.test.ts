import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PluginService } from '../../../../plugins/plugin-service'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { setPluginServiceForRpc } from './plugins'
import { PLUGIN_SETTINGS_METHODS } from './plugin-settings'

let root: string
let service: PluginService
let dispatcher: RpcDispatcher
let settingsPath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-declared-settings-rpc-'))
  const pluginDir = join(root, 'fixture')
  await mkdir(pluginDir)
  await writeFile(
    join(pluginDir, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      execution: 'trusted-worker',
      id: 'settings-probe',
      name: 'Settings probe',
      version: '1.0.0',
      engines: { orca: '>=1.4.246' },
      pluginApi: 1,
      main: 'main.mjs',
      capabilities: [{ kind: 'settings:own' }],
      contributes: {
        settings: [
          { key: 'enabled', title: 'Enabled', type: 'boolean', default: true },
          { key: 'limit', title: 'Limit', type: 'integer', default: 5, minimum: 0 },
          { key: 'label', title: 'Label', type: 'string', default: 'Default' },
          { key: 'constructor', title: 'Constructor', type: 'string' }
        ]
      }
    })
  )
  await writeFile(join(pluginDir, 'main.mjs'), 'export default function activate() {}')
  service = new PluginService({
    userDataPath: root,
    hostVersion: '1.4.999',
    isPluginSystemEnabled: () => true,
    getDisabledPlugins: () => [],
    getPluginConsents: () => ({}),
    getDevPluginPaths: () => [pluginDir]
  })
  await service.initialize()
  setPluginServiceForRpc(service)
  dispatcher = new RpcDispatcher({
    runtime: new OrcaRuntimeService(),
    methods: PLUGIN_SETTINGS_METHODS
  })
  settingsPath = join(root, 'plugins-data', 'local.settings-probe', 'settings.json')
  await mkdir(join(root, 'plugins-data', 'local.settings-probe'), { recursive: true })
  await writeFile(settingsPath, '{"privateKey":"not-declared"}')
})

afterEach(async () => {
  setPluginServiceForRpc(null)
  await service?.dispose()
  await rm(root, { recursive: true, force: true })
})

function get(key?: string) {
  return dispatcher.dispatch({
    id: 'get',
    authToken: 'test-owner-token',
    method: 'plugins.getSettings',
    params: { pluginKey: 'local.settings-probe', key }
  })
}

function set(key: string, value: unknown) {
  return dispatcher.dispatch({
    id: 'set',
    authToken: 'test-owner-token',
    method: 'plugins.setSetting',
    params: { pluginKey: 'local.settings-probe', key, value }
  })
}

it('persists falsy overrides and restores defaults without returning undeclared data', async () => {
  expect(await get()).toMatchObject({
    ok: true,
    result: { values: { enabled: true, limit: 5, label: 'Default' } }
  })
  expect(JSON.stringify(await get())).not.toContain('not-declared')
  expect(await set('enabled', false)).toMatchObject({ ok: true, result: { value: false } })
  expect(await set('limit', 0)).toMatchObject({ ok: true, result: { value: 0 } })
  expect(await set('label', '')).toMatchObject({ ok: true, result: { value: '' } })
  expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
    privateKey: 'not-declared',
    enabled: false,
    limit: 0,
    label: ''
  })
  expect(await set('label', null)).toMatchObject({ ok: true, result: { value: 'Default' } })
  expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
    privateKey: 'not-declared',
    enabled: false,
    limit: 0
  })
  expect(await set('constructor', null)).toMatchObject({ ok: true, result: { value: null } })
})

it('refuses mobile, invalid values and undeclared keys before changing persistent settings', async () => {
  expect(
    await dispatcher.dispatch(
      {
        id: 'mobile-set',
        authToken: 'test-owner-token',
        method: 'plugins.setSetting',
        params: { pluginKey: 'local.settings-probe', key: 'label', value: 'changed' }
      },
      { callerScope: { kind: 'mobile' } }
    )
  ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(
    await dispatcher.dispatch(
      {
        id: 'mobile-get',
        authToken: 'test-owner-token',
        method: 'plugins.getSettings',
        params: { pluginKey: 'local.settings-probe' }
      },
      { callerScope: { kind: 'mobile' } }
    )
  ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(await set('privateKey', 'changed')).toMatchObject({
    ok: false,
    error: { code: 'invalid_argument' }
  })
  expect(await get('privateKey')).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  expect(await set('limit', 1.5)).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  expect(await set('enabled', 'false')).toMatchObject({
    ok: false,
    error: { code: 'invalid_argument' }
  })
  expect(
    await dispatcher.dispatch({
      id: 'missing',
      authToken: 'test-owner-token',
      method: 'plugins.getSettings',
      params: { pluginKey: 'local.missing' }
    })
  ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
  expect(await readFile(settingsPath, 'utf8')).toBe('{"privateKey":"not-declared"}')
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'refuses resets and writes against unreadable settings without losing existing overrides',
  async () => {
    await writeFile(settingsPath, '{"label":"OVERRIDE","limit":7}')
    await chmod(settingsPath, 0o000)
    try {
      expect(await set('label', null)).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    } finally {
      await chmod(settingsPath, 0o600)
    }
    expect(await readFile(settingsPath, 'utf8')).toBe('{"label":"OVERRIDE","limit":7}')
    await chmod(dirname(settingsPath), 0o000)
    try {
      expect(await set('label', 'NEW')).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' }
      })
    } finally {
      await chmod(dirname(settingsPath), 0o700)
    }
    expect(await readFile(settingsPath, 'utf8')).toBe('{"label":"OVERRIDE","limit":7}')
  }
)
