import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs'
import { normalizeCommandPositionals, parseArgs, specPaths } from '../args'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeRpcFailureError } from '../runtime/types'
import type { PluginShotActResult } from '../../shared/plugins/view/plugin-shot-acts'
import { PLUGIN_VIEW_HANDLERS, formatPluginShot, type PluginShotReply } from './plugin-view'

// A 1x1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function parse(argv: string[]) {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  return normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
}

function context(
  argv: string[],
  call: ReturnType<typeof vi.fn>,
  options: { cwd: string; remote?: boolean }
): HandlerContext {
  const parsed = parse(argv)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only call client.call and read isRemote.
  const client = { call, isRemote: options.remote === true } as unknown as RuntimeClient
  return { flags: parsed.flags, client, cwd: options.cwd, json: true, rawArgs: argv }
}

function shotReply(overrides: Partial<PluginShotReply> = {}): { result: PluginShotReply } {
  return {
    result: {
      pluginKey: 'acme.todos',
      panelId: 'todos',
      title: 'Todos',
      ui: 'components',
      png: PNG_BASE64,
      width: 360,
      height: 700,
      colorScheme: 'dark',
      themeApplied: true,
      settled: true,
      errors: [],
      ...overrides
    }
  }
}

let cwd: string
let stdout: string[]

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'orca-plugin-shot-'))
  stdout = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  delete process.env.ORCA_CLI_CWD
  await rm(cwd, { recursive: true, force: true })
})

describe('orca plugin open / shot arguments', () => {
  it('parses the plugin key positionally with the view flags', () => {
    const open = parse(['plugin', 'open', 'acme.todos', '--panel', 'stats'])
    expect(open.commandPath).toEqual(['plugin', 'open'])
    expect(open.flags.get('plugin')).toBe('acme.todos')
    expect(open.flags.get('panel')).toBe('stats')
    const shot = parse(['plugin', 'shot', 'acme.todos', '--theme', 'light', '--width', '360'])
    expect(shot.commandPath).toEqual(['plugin', 'shot'])
    expect(shot.flags.get('theme')).toBe('light')
    expect(shot.flags.get('width')).toBe('360')
    expect(parse(['plugin', 'dev', 'watch', '.', '--shot', 'out']).flags.get('shot')).toBe('out')
  })
})

describe('orca plugin open', () => {
  it('opens the default panel', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { pluginKey: 'acme.todos', kind: 'panel', panelId: 'todos', title: 'Todos' }
    })
    await PLUGIN_VIEW_HANDLERS['plugin open'](
      context(['plugin', 'open', 'acme.todos'], call, { cwd })
    )
    expect(call).toHaveBeenCalledWith('plugins.open', { pluginKey: 'acme.todos' })
  })

  it('sends --editor as a host path, absolute on a remote host', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { pluginKey: 'acme.notes', kind: 'editor', editorId: 'e', title: 'N', filePath: 'x' }
    })
    await PLUGIN_VIEW_HANDLERS['plugin open'](
      context(['plugin', 'open', 'acme.notes', '--editor', 'docs/a.notes'], call, { cwd })
    )
    expect(call.mock.calls[0]?.[1]).toEqual({
      pluginKey: 'acme.notes',
      filePath: join(cwd, 'docs/a.notes')
    })
    await expect(
      PLUGIN_VIEW_HANDLERS['plugin open'](
        context(['plugin', 'open', 'acme.notes', '--editor', 'docs/a.notes'], call, {
          cwd,
          remote: true
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('refuses --panel with --editor and a malformed key', async () => {
    const call = vi.fn()
    await expect(
      PLUGIN_VIEW_HANDLERS['plugin open'](
        context(['plugin', 'open', 'acme.todos', '--panel', 'a', '--editor', 'b'], call, { cwd })
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(
      PLUGIN_VIEW_HANDLERS['plugin open'](context(['plugin', 'open', 'todos'], call, { cwd }))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('says the host is too old when it lacks the method', async () => {
    const call = vi.fn().mockRejectedValue(
      new RuntimeRpcFailureError({
        id: 'r',
        ok: false,
        error: { code: 'method_not_found', message: 'nope' },
        _meta: { runtimeId: 'runtime_local' }
      })
    )
    await expect(
      PLUGIN_VIEW_HANDLERS['plugin open'](context(['plugin', 'open', 'acme.todos'], call, { cwd }))
    ).rejects.toMatchObject({ code: 'runtime_unsupported' })
  })
})

describe('orca plugin shot', () => {
  it('writes the PNG to .orca/shots under cwd by default', async () => {
    const call = vi.fn().mockResolvedValue(shotReply())
    await PLUGIN_VIEW_HANDLERS['plugin shot'](
      context(['plugin', 'shot', 'acme.todos', '--theme', 'dark', '--width', '360'], call, { cwd })
    )
    expect(call).toHaveBeenCalledWith(
      'plugins.shot',
      { pluginKey: 'acme.todos', colorScheme: 'dark', width: 360 },
      { timeoutMs: 30_000 }
    )
    const path = join(cwd, '.orca', 'shots', 'acme.todos-todos.png')
    expect((await readFile(path)).toString('base64')).toBe(PNG_BASE64)
    expect(JSON.parse(stdout.join('')).result).toEqual({
      path,
      pluginKey: 'acme.todos',
      panelId: 'todos',
      width: 360,
      height: 700,
      theme: 'dark',
      themeApplied: true,
      settled: true,
      errors: []
    })
  })

  it('writes to --out, also for a remote host', async () => {
    const call = vi.fn().mockResolvedValue(shotReply())
    await PLUGIN_VIEW_HANDLERS['plugin shot'](
      context(['plugin', 'shot', 'acme.todos', '--out', 'a/b.png'], call, { cwd, remote: true })
    )
    expect((await readFile(join(cwd, 'a', 'b.png'))).byteLength).toBeGreaterThan(0)
  })

  it('checks --theme and --width before reaching the host', async () => {
    const call = vi.fn()
    for (const argv of [
      ['plugin', 'shot', 'acme.todos', '--theme', 'sepia'],
      ['plugin', 'shot', 'acme.todos', '--width', '10'],
      ['plugin', 'shot', 'acme.todos', '--width', 'wide']
    ]) {
      await expect(
        PLUGIN_VIEW_HANDLERS['plugin shot'](context(argv, call, { cwd }))
      ).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses a bridged shell, whose cwd is on another machine', async () => {
    process.env.ORCA_CLI_CWD = '/remote/home'
    await expect(
      PLUGIN_VIEW_HANDLERS['plugin shot'](
        context(['plugin', 'shot', 'acme.todos'], vi.fn(), { cwd })
      )
    ).rejects.toMatchObject({ code: 'invalid_environment' })
  })

  it('prints theme, drawing and error notes in text', () => {
    const text = formatPluginShot(
      {
        path: '/w/a.png',
        pluginKey: 'acme.todos',
        panelId: 'todos',
        width: 300,
        height: 600,
        theme: 'dark',
        themeApplied: false,
        themeReason: 'the Orca window is visible; capturing in the current theme',
        settled: false,
        errors: ['src/panel.tsx:4 boom']
      },
      'light'
    )
    expect(text).toBe(
      [
        'Saved /w/a.png (300x600, dark theme)',
        '  note: light was not applied (the Orca window is visible; capturing in the current theme); it shows dark.',
        '  note: the panel had not finished drawing; this is what it showed.',
        '  error: src/panel.tsx:4 boom'
      ].join('\n')
    )
  })

  it('writes beside the plugin when run inside its folder', async () => {
    const plugin = join(cwd, 'todos')
    await mkdir(join(plugin, 'src'), { recursive: true })
    await writeFile(join(plugin, 'orca-plugin.json'), '{}')
    await PLUGIN_VIEW_HANDLERS['plugin shot'](
      context(['plugin', 'shot', 'acme.todos'], vi.fn().mockResolvedValue(shotReply()), {
        cwd: join(plugin, 'src')
      })
    )
    expect(JSON.parse(stdout.join('')).result.path).toBe(
      join(plugin, '.orca', 'shots', 'acme.todos-todos.png')
    )
  })

  it('sends --act, reports each act, and exits 1 when one failed', async () => {
    const actions: PluginShotActResult[] = [
      { ok: true },
      { ok: false, error: 'press: the Button is disabled' }
    ]
    const call = vi.fn().mockResolvedValue(shotReply({ actions }))
    const acts = '[{"type":{"label":"New task"},"text":"Ship"},{"press":{"text":"Add"}}]'
    await PLUGIN_VIEW_HANDLERS['plugin shot'](
      context(['plugin', 'shot', 'acme.todos', '--act', acts], call, { cwd })
    )
    expect(call).toHaveBeenCalledWith(
      'plugins.shot',
      { pluginKey: 'acme.todos', acts: JSON.parse(acts) },
      { timeoutMs: 40_000 }
    )
    expect(JSON.parse(stdout.join('')).result.actions).toEqual(actions)
    expect(process.exitCode).toBe(1)
  })

  it('checks --act before reaching the host, and refuses a host that ignored it', async () => {
    const call = vi.fn().mockResolvedValue(shotReply())
    await expect(
      PLUGIN_VIEW_HANDLERS['plugin shot'](
        context(['plugin', 'shot', 'acme.todos', '--act', '[{"click":{}}]'], call, { cwd })
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringMatching(/^--act: /)
    })
    expect(call).not.toHaveBeenCalled()
    await expect(
      PLUGIN_VIEW_HANDLERS['plugin shot'](
        context(['plugin', 'shot', 'acme.todos', '--act', '{"press":{"text":"Add"}}'], call, {
          cwd
        })
      )
    ).rejects.toMatchObject({ code: 'runtime_unsupported' })
  })

  it('passes pendingRequests and restored on, and notes them in text', async () => {
    const call = vi
      .fn()
      .mockResolvedValue(
        shotReply({ pendingRequests: 2, actions: [{ ok: true }], restored: false })
      )
    await PLUGIN_VIEW_HANDLERS['plugin shot'](
      context(['plugin', 'shot', 'acme.todos', '--act', '{"press":{"text":"Add"}}'], call, { cwd })
    )
    expect(JSON.parse(stdout.join('')).result).toMatchObject({
      pendingRequests: 2,
      actions: [{ ok: true }],
      restored: false
    })
    const text = formatPluginShot({
      path: '/w/a.png',
      pluginKey: 'acme.todos',
      panelId: 'todos',
      width: 300,
      height: 600,
      theme: 'dark',
      themeApplied: false,
      settled: true,
      errors: [],
      pendingRequests: 2,
      restored: false
    })
    expect(text).toContain('2 host call(s) (plugin.request included) were unanswered after 3s')
    expect(text).toContain('its acted state was not put back')
  })
})
