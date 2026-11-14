import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../../arguments/args'
import { specPaths } from '../../discovery/command-spec'
import type { HandlerContext } from '../../dispatch/dispatch'
import type { RuntimeClient } from '../../runtime/client'
import { PLUGIN_VIEW_HANDLERS } from './plugin-view'

// A 1x1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

function context(argv: string[], call: ReturnType<typeof vi.fn>, cwd: string): HandlerContext {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only call client.call and read isRemote.
  const client = { call, isRemote: false } as unknown as RuntimeClient
  return { flags: parsed.flags, client, cwd, json: true, rawArgs: argv }
}

const reply = (overrides: Record<string, unknown> = {}) => ({
  result: {
    pluginKey: 'local.sketch',
    editorId: 'sketch',
    title: 'Sketch',
    filePath: '/w/a.sketch',
    png: PNG_BASE64,
    width: 800,
    height: 600,
    colorScheme: 'light',
    themeApplied: true,
    settled: true,
    subscribed: true,
    errors: [],
    ...overrides
  }
})

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'orca-editor-shot-'))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  await rm(cwd, { recursive: true, force: true })
})

const shot = (argv: string[], call: ReturnType<typeof vi.fn>) =>
  PLUGIN_VIEW_HANDLERS['plugin shot']!(context(['plugin', 'shot', ...argv], call, cwd))

describe('orca plugin shot --editor', () => {
  it('takes a plugin folder, sends size and acts, and writes the PNG under .orca/shots', async () => {
    await mkdir(join(cwd, 'sketch'))
    await writeFile(
      join(cwd, 'sketch', 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'sandboxed-ui',
        id: 'sketch',
        name: 'Sketch',
        version: '1.0.0',
        engines: { orca: '>=1.4.246' },
        contributes: {
          customEditors: [
            { id: 'sketch', title: 'Sketch', entry: 'editor.html', extensions: ['.sketch'] }
          ]
        }
      })
    )
    const call = vi.fn().mockResolvedValue(reply({ acted: 2 }))
    await shot(
      [
        './sketch',
        '--editor',
        'a.sketch',
        '--theme',
        'light',
        '--width',
        '800',
        '--height',
        '600',
        '--act',
        '[{"click":[10,20]},{"key":"r"}]'
      ],
      call
    )
    expect(call).toHaveBeenCalledWith(
      'plugins.shotEditor',
      {
        pluginKey: 'local.sketch',
        filePath: join(cwd, 'a.sketch'),
        colorScheme: 'light',
        width: 800,
        height: 600,
        acts: [{ click: [10, 20] }, { key: 'r' }]
      },
      expect.anything()
    )
    const png = await readFile(join(cwd, '.orca', 'shots', 'local.sketch-sketch.png'))
    expect(png.toString('base64')).toBe(PNG_BASE64)
    expect(process.exitCode).toBeUndefined()
  })

  it('passes --in-place, and notes whether acts ran on a copy', async () => {
    const call = vi.fn().mockResolvedValue(reply({ acted: 1 }))
    await shot(
      [
        'local.sketch',
        '--editor',
        '/w/a.sketch',
        '--act',
        '{"key":"r"}',
        '--out',
        'x.png',
        '--in-place'
      ],
      call
    )
    expect(call.mock.calls[0]?.[1]).toMatchObject({ inPlace: true, acts: [{ key: 'r' }] })
    await expect(shot(['local.sketch', '--in-place'], vi.fn())).rejects.toThrow(/--editor/)
  })

  it('exits 1 when the editor never asked for its document or logged errors', async () => {
    await shot(
      ['local.sketch', '--editor', 'a.sketch', '--out', 'x.png'],
      vi.fn().mockResolvedValue(reply({ subscribed: false, errors: ['never asked'] }))
    )
    expect(process.exitCode).toBe(1)
  })

  it('checks its flags before reaching the host', async () => {
    const call = vi.fn()
    const run = (argv: string[]) => shot(['local.sketch', '--editor', 'a.sketch', ...argv], call)
    await expect(run(['--act', '[{"click":[-1,0]}]'])).rejects.toThrow(/--act: action 1/)
    await expect(run(['--height', '50'])).rejects.toThrow(/--height takes/)
    await expect(run(['--panel', 'p'])).rejects.toThrow(/--panel or --editor/)
    await expect(shot(['local.sketch', '--height', '600'], call)).rejects.toThrow(/--editor/)
    expect(call).not.toHaveBeenCalled()
  })
})
