import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../../arguments/args'
import { specPaths } from '../../discovery/command-spec'
import type { HandlerContext } from '../../dispatch/dispatch'
import type { RuntimeClient } from '../../runtime/client'
import { RuntimeRpcFailureError } from '../../runtime/connection/types'
import { createPluginFromTemplate } from '../authoring/plugin-create'
import { PLUGIN_VIEW_HANDLERS, type PluginShotReply } from './plugin-view'

const check = vi.hoisted(() => ({
  readPluginCheckScenarioNames: vi.fn<(dir: string, entry: string) => Promise<string[]>>(),
  checkPluginPanels: vi.fn(),
  formatPluginPanelCheck: vi.fn(() => ['  src/panel.tsx: boom'])
}))
vi.mock('../authoring/plugin-panel-check', () => check)

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const TREE = { type: 'Text', props: {}, children: ['3 counted'] }

function context(
  argv: string[],
  call: ReturnType<typeof vi.fn>,
  options: { cwd: string; remote?: boolean }
): HandlerContext {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only call client.call and read isRemote.
  const client = { call, isRemote: options.remote === true } as unknown as RuntimeClient
  return { flags: parsed.flags, client, cwd: options.cwd, json: true, rawArgs: argv }
}

function replayReply(overrides: Partial<PluginShotReply & { replay: true }> = {}) {
  return {
    pluginKey: 'x',
    panelId: 'counter',
    title: 'Counter',
    ui: 'components',
    png: PNG_BASE64,
    width: 320,
    height: 120,
    colorScheme: 'dark',
    themeApplied: true,
    settled: true,
    errors: [],
    replay: true,
    scenario: 'counted',
    ...overrides
  }
}

let root: string
let dir: string
let pluginKey: string
let panelId: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-shot-scenario-')))
  dir = join(root, 'counter')
  await createPluginFromTemplate({ dir, template: 'worker-panel' })
  const manifest = JSON.parse(await readFile(join(dir, 'orca-plugin.json'), 'utf8'))
  pluginKey = `${manifest.publisher ?? 'local'}.${manifest.id}`
  panelId = manifest.contributes.panels[0].id
  check.readPluginCheckScenarioNames.mockResolvedValue(['fresh', 'counted'])
  check.checkPluginPanels.mockResolvedValue([
    { panel: panelId, entry: 'src/panel.tsx', scenario: 'counted', drawnTree: TREE, issues: [] }
  ])
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  check.readPluginCheckScenarioNames.mockReset()
  check.checkPluginPanels.mockReset()
  process.exitCode = undefined
  delete process.env.ORCA_CLI_CWD
  await rm(root, { recursive: true, force: true })
})

const run = (argv: string[], call: ReturnType<typeof vi.fn>, remote = false) =>
  PLUGIN_VIEW_HANDLERS['plugin shot'](context(argv, call, { cwd: root, remote }))

describe('orca plugin shot --scenario', () => {
  it('refuses another host and a bridged shell, since it runs the code here', async () => {
    await expect(
      run(['plugin', 'shot', dir, '--scenario', 'counted'], vi.fn(), true)
    ).rejects.toMatchObject({ code: 'invalid_environment' })
    process.env.ORCA_CLI_CWD = '/elsewhere'
    await expect(
      run(['plugin', 'shot', dir, '--scenario', 'counted'], vi.fn())
    ).rejects.toMatchObject({ code: 'invalid_environment' })
    expect(check.readPluginCheckScenarioNames).not.toHaveBeenCalled()
  })

  it('takes a dev plugin key inside its folder and refuses an installed one', async () => {
    const list = (isDev: boolean) =>
      vi.fn(async (method: string) => ({
        result: method === 'plugins.list' ? [{ pluginKey, isDev }] : replayReply()
      }))
    await expect(
      PLUGIN_VIEW_HANDLERS['plugin shot'](
        context(['plugin', 'shot', pluginKey, '--scenario', 'counted'], list(false), { cwd: dir })
      )
    ).rejects.toThrow(/is installed, not a development folder/)
    expect(check.readPluginCheckScenarioNames).not.toHaveBeenCalled()
    const dev = list(true)
    await PLUGIN_VIEW_HANDLERS['plugin shot'](
      context(['plugin', 'shot', pluginKey, '--scenario', 'counted'], dev, { cwd: dir })
    )
    expect(dev.mock.calls.map(([method]) => method)).toEqual(['plugins.list', 'plugins.shotReplay'])
    // A key from outside its folder: Orca does not share dev folder paths.
    await expect(
      run(['plugin', 'shot', pluginKey, '--scenario', 'counted'], list(true))
    ).rejects.toThrow(/Run this inside/)
  })

  it('reports an older host as runtime_unsupported, never falling back to a live shot', async () => {
    const tooOld = vi.fn(async (_method: string) => {
      throw new RuntimeRpcFailureError({
        id: '1',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method: plugins.shotReplay' },
        _meta: { runtimeId: 'r' }
      })
    })
    await expect(
      run(['plugin', 'shot', dir, '--scenario', 'counted'], tooOld)
    ).rejects.toMatchObject({ code: 'runtime_unsupported' })
    expect(tooOld.mock.calls.map(([method]) => method)).toEqual(['plugins.shotReplay'])
    // A host that answered without drawing the replay is not trusted either.
    const ignored = vi.fn(async () => ({ result: { ...replayReply(), replay: undefined } }))
    await expect(
      run(['plugin', 'shot', dir, '--scenario', 'counted'], ignored)
    ).rejects.toMatchObject({ code: 'runtime_unsupported' })
  })
})
