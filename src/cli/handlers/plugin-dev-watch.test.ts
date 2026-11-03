import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs'
import { findCommandSpec, normalizeCommandPositionals, parseArgs, specPaths } from '../args'
import type { HandlerContext } from '../dispatch'
import { reportCliError } from '../cli-error'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'
import {
  bindPluginDevWatchHost,
  devReloadArgs,
  PluginHostUnreachableError
} from './plugin-dev-watch'

function context(call: ReturnType<typeof vi.fn>, rawArgs: string[] = []): HandlerContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watch host only calls client.call and reads isRemote.
  const client = { call, isRemote: true } as unknown as RuntimeClient
  return { flags: new Map(), client, cwd: '/work', json: false, rawArgs }
}

function rpcFailure(code: string, data?: unknown): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'req',
    ok: false,
    error: { code, message: `${code} message`, data },
    _meta: { runtimeId: 'runtime_local' }
  })
}

function parse(argv: string[]) {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  return normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
}

describe('orca plugin dev watch', () => {
  it('parses alongside the other dev subcommands', () => {
    const watch = parse(['plugin', 'dev', 'watch', '.'])
    expect(watch.commandPath).toEqual(['plugin', 'dev', 'watch'])
    expect(watch.flags.get('dir')).toBe('.')
    expect(parse(['plugin', 'dev', 'reload']).commandPath).toEqual(['plugin', 'dev', 'reload'])
    expect(findCommandSpec(COMMAND_SPECS, ['plugin', 'dev'])).toBeUndefined()
  })

  it('turns the watch command into the matching reload command for approval', () => {
    expect(
      devReloadArgs(['--json', 'plugin', 'dev', 'watch', 'watch', '--environment', 'box'])
    ).toEqual(['--json', 'plugin', 'dev', 'reload', 'watch', '--environment', 'box'])
  })

  it('suggests an approval command that dev reload accepts, without watch-only flags', async () => {
    const rawArgs = [
      'plugin',
      'dev',
      'watch',
      '--check',
      '/work/notes',
      '--shot',
      './shots',
      '--shot-panel=stats',
      '--approve',
      'ap1-old',
      '--json',
      '--environment',
      'box'
    ]
    const call = vi
      .fn()
      .mockRejectedValue(rpcFailure('approval_required', { approvalFingerprint: 'ap1-new' }))
    const approval = await bindPluginDevWatchHost(
      context(call, rawArgs),
      '/work/notes'
    ).approvalNeeded()
    const argv = approval?.command.split(' ').slice(1) ?? []
    const parsed = parse(argv)
    expect(parsed.commandPath).toEqual(['plugin', 'dev', 'reload'])
    const spec = findCommandSpec(COMMAND_SPECS, parsed.commandPath)
    expect([...parsed.flags.keys()].filter((flag) => !spec?.allowedFlags.includes(flag))).toEqual(
      []
    )
    expect(Object.fromEntries(parsed.flags)).toEqual({
      dir: '/work/notes',
      approve: 'ap1-new',
      json: true,
      environment: 'box'
    })
  })

  it('treats a transport failure as a lost host but a host error reply as a reply', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'Orca is not running'))
      .mockRejectedValueOnce(rpcFailure('internal_error'))
    const host = bindPluginDevWatchHost(context(call), '/work/notes')
    await expect(host.list()).rejects.toBeInstanceOf(PluginHostUnreachableError)
    const reply = await host.list().catch((error: unknown) => error)
    expect(reply).not.toBeInstanceOf(PluginHostUnreachableError)
    expect(reply).toMatchObject({ code: 'internal_error' })
  })

  it('sends the log cursor only once the host gave one', async () => {
    const call = vi.fn().mockResolvedValue({ result: { pluginKey: 'acme.notes', lines: [] } })
    const host = bindPluginDevWatchHost(context(call), '/work/notes')
    await host.logs('acme.notes', undefined)
    await host.logs('acme.notes', 'n:4')
    expect(call.mock.calls.map((args) => args[1])).toEqual([
      { pluginKey: 'acme.notes' },
      { pluginKey: 'acme.notes', after: 'n:4' }
    ])
  })

  it('reads a mid-session approval as a reload command to run elsewhere', async () => {
    const call = vi.fn().mockRejectedValue(
      rpcFailure('approval_required', {
        approvalFingerprint: 'ap1-abc',
        nextSteps: ['To approve, run the same command again with --approve ap1-abc.']
      })
    )
    const host = bindPluginDevWatchHost(
      context(call, ['plugin', 'dev', 'watch', '/work/notes']),
      '/work/notes'
    )
    await expect(host.approvalNeeded()).resolves.toEqual({
      message: 'approval_required message',
      fingerprint: 'ap1-abc',
      command: 'orca plugin dev reload /work/notes --approve ap1-abc'
    })
  })
})

describe('plugin dev watch --json errors', () => {
  it('prints a failed first load as one JSON line, unlike other commands', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const error = new RuntimeClientError('approval_required', 'acme.notes needs approval')
      reportCliError(error, true, { commandPath: ['plugin', 'dev', 'watch'] })
      reportCliError(error, true, { commandPath: ['plugin', 'dev', 'load'] })
      const [watchLine, loadOutput] = log.mock.calls.map(([text]) => String(text))
      expect(watchLine).not.toContain('\n')
      expect(JSON.parse(watchLine)).toMatchObject({
        ok: false,
        error: { code: 'approval_required' }
      })
      expect(loadOutput).toContain('\n')
    } finally {
      log.mockRestore()
    }
  })
})

describe('plugin dev watch --check', () => {
  it('parses as a flag before or after the folder', () => {
    for (const argv of [
      ['plugin', 'dev', 'watch', '.', '--check'],
      ['plugin', 'dev', 'watch', '--check', '.']
    ]) {
      const parsed = parse(argv)
      expect(parsed.flags.get('check')).toBe(true)
      expect(parsed.flags.get('dir')).toBe('.')
    }
  })

  it('needs a local folder, since it renders the plugin on this machine', () => {
    const remote = context(vi.fn())
    remote.flags.set('check', true)
    expect(() => bindPluginDevWatchHost(remote, '/work/notes')).toThrow(/needs a local folder/)
    expect(bindPluginDevWatchHost(context(vi.fn()), '/work/notes').check).toBeUndefined()
  })
})

describe('plugin dev watch --shot', () => {
  it('parses --shot-panel and needs --shot with it', () => {
    const parsed = parse(['plugin', 'dev', 'watch', '.', '--shot', 'out', '--shot-panel', 'stats'])
    expect(parsed.flags.get('shot-panel')).toBe('stats')
    const ctx = context(vi.fn())
    ctx.flags.set('shot-panel', 'stats')
    expect(() => bindPluginDevWatchHost(ctx, '/work/notes')).toThrow(/needs --shot/)
  })

  it('opens once by RPC, then shoots only while shown, also from a remote host', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-watch-shot-'))
    try {
      const png = Buffer.from('png').toString('base64')
      const replies = [
        {
          pluginKey: 'acme.notes',
          panelId: 'a',
          png,
          width: 300,
          height: 500,
          colorScheme: 'dark',
          themeApplied: false,
          settled: true,
          errors: [],
          pendingRequests: 1
        },
        {
          pluginKey: 'acme.notes',
          panelId: 'a',
          title: 'A',
          notShown: 'the right sidebar is closed'
        }
      ]
      const call = vi.fn(async (method: string, _params?: unknown) => ({
        result: method === 'plugins.open' ? { kind: 'panel' } : replies.shift()
      }))
      const ctx = context(call)
      ctx.flags.set('shot', dir)
      const shot = bindPluginDevWatchHost(ctx, '/work/notes').shot
      await shot?.open('acme.notes', 'a')
      await expect(shot?.take('acme.notes', 'a')).resolves.toMatchObject({
        path: join(dir, 'acme.notes-a.png'),
        pendingRequests: 1
      })
      await expect(shot?.take('acme.notes', 'a')).resolves.toEqual({
        notShown: 'the right sidebar is closed'
      })
      expect(await readFile(join(dir, 'acme.notes-a.png'), 'utf8')).toBe('png')
      expect(call.mock.calls.map(([method, params]) => [method, params])).toEqual([
        ['plugins.open', { pluginKey: 'acme.notes', panelId: 'a' }],
        ['plugins.shot', { pluginKey: 'acme.notes', panelId: 'a', ifShown: true }],
        ['plugins.shot', { pluginKey: 'acme.notes', panelId: 'a', ifShown: true }]
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
