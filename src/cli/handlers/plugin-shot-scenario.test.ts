import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs'
import { normalizeCommandPositionals, parseArgs, specPaths } from '../args'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeRpcFailureError } from '../runtime/types'
import { createPluginFromTemplate } from '../plugin-authoring/plugin-create'
import { PLUGIN_VIEW_HANDLERS, type PluginShotReply } from './plugin-view'
import { pluginScenarioFileStem } from './plugin-shot-scenario'

const check = vi.hoisted(() => ({
  readPluginCheckScenarioNames: vi.fn<(dir: string, entry: string) => Promise<string[]>>(),
  checkPluginPanels: vi.fn(),
  formatPluginPanelCheck: vi.fn(() => ['  src/panel.tsx: boom'])
}))
vi.mock('../plugin-authoring/plugin-panel-check', () => check)

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
let stdout: string[]

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
  stdout = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
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

const printed = () => JSON.parse(stdout.join('')).result

describe('orca plugin shot --scenario', () => {
  it('renders the scenario here and sends only its tree to plugins.shotReplay', async () => {
    const call = vi.fn(async () => ({ result: replayReply() }))
    await run(['plugin', 'shot', dir, '--scenario', 'counted', '--theme', 'dark'], call)
    expect(check.checkPluginPanels).toHaveBeenCalledWith(dir, {
      panel: panelId,
      scenario: 'counted',
      drawnTree: true
    })
    expect(call.mock.calls).toEqual([
      [
        'plugins.shotReplay',
        {
          pluginKey,
          panelId,
          title: expect.any(String),
          scenario: 'counted',
          tree: TREE,
          colorScheme: 'dark'
        },
        { timeoutMs: expect.any(Number) }
      ]
    ])
    const result = printed()
    expect(result).toMatchObject({ replay: true, scenario: 'counted', errors: [] })
    expect(result.notes[0]).toMatch(/host-owned control values start from the tree's props/)
    expect(result.path).toBe(join(dir, '.orca', 'shots', `${pluginKey}-${panelId}.counted.png`))
    expect((await readFile(result.path)).toString('base64')).toBe(PNG_BASE64)
  })

  it('lists the scenarios when the name is unknown, before running anything', async () => {
    const call = vi.fn()
    await expect(run(['plugin', 'shot', dir, '--scenario', 'nope'], call)).rejects.toThrow(
      /has no scenario "nope"; its scenarios: fresh, counted/
    )
    expect(check.checkPluginPanels).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  })

  it('says how to add scenarios when the panel has none', async () => {
    check.readPluginCheckScenarioNames.mockResolvedValue([])
    await expect(run(['plugin', 'shot', dir, '--scenario', 'counted'], vi.fn())).rejects.toThrow(
      /has no scenarios: add src\/panel\.check\.ts/
    )
  })

  it('refuses --act with --scenario', async () => {
    const call = vi.fn()
    await expect(
      run(
        ['plugin', 'shot', dir, '--scenario', 'counted', '--act', '[{"press":{"text":"+"}}]'],
        call
      )
    ).rejects.toThrow(/pass one/)
    expect(check.readPluginCheckScenarioNames).not.toHaveBeenCalled()
  })

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

  it('still shoots a tree whose render had issues, listing them in errors', async () => {
    check.checkPluginPanels.mockResolvedValue([
      {
        panel: panelId,
        entry: 'src/panel.tsx',
        drawnTree: TREE,
        issues: [{ kind: 'plugin', message: 'boom', location: 'src/panel.tsx:4:7' }]
      }
    ])
    await run(
      ['plugin', 'shot', dir, '--scenario', 'counted'],
      vi.fn(async () => ({ result: replayReply() }))
    )
    expect(printed().errors).toEqual(['src/panel.tsx:4:7: boom'])
  })

  it('fails when the scenario drew no tree, without reaching the host', async () => {
    check.checkPluginPanels.mockResolvedValue([
      {
        panel: panelId,
        entry: 'src/panel.tsx',
        drawnTree: null,
        issues: [{ kind: 'plugin', message: 'boom' }]
      }
    ])
    const call = vi.fn()
    await expect(run(['plugin', 'shot', dir, '--scenario', 'counted'], call)).rejects.toMatchObject(
      {
        code: 'plugin_check_failed'
      }
    )
    expect(call).not.toHaveBeenCalled()
  })

  it('names files safely after the scenario', () => {
    expect(pluginScenarioFileStem('counted')).toBe('counted')
    expect(pluginScenarioFileStem('../a b/c')).toBe('a-b-c')
    expect(pluginScenarioFileStem('///')).toBe('scenario')
  })
})
