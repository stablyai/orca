import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs'
import { findCommandSpec, normalizeCommandPositionals, parseArgs, specPaths } from '../args'
import type { HandlerContext } from '../dispatch'
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
