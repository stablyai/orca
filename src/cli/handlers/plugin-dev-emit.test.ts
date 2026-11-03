import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs'
import { normalizeCommandPositionals, parseArgs, specPaths } from '../args'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeRpcFailureError } from '../runtime/types'
import { PLUGIN_DEV_EMIT_HANDLERS } from './plugin-dev-emit'

function parse(argv: string[]) {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  return normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
}

function context(call: ReturnType<typeof vi.fn>, argv: string[]): HandlerContext {
  const parsed = parse(argv)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls client.call and reads isRemote.
  const client = { call, isRemote: false } as unknown as RuntimeClient
  return { flags: parsed.flags, client, cwd: '/work', json: true, rawArgs: argv }
}

const REPLY = {
  pluginKey: 'acme.notes',
  event: 'workspace.created',
  delivered: { worker: true, panels: 0 }
}

describe('orca plugin dev emit', () => {
  it('parses alongside the other dev subcommands', () => {
    const emit = parse(['plugin', 'dev', 'emit', '.', 'workspace.created', '--data', '{}'])
    expect(emit.commandPath).toEqual(['plugin', 'dev', 'emit'])
    expect(emit.flags.get('target')).toBe('.')
    expect(emit.flags.get('event')).toBe('workspace.created')
    expect(emit.flags.get('data')).toBe('{}')
    expect(parse(['plugin', 'dev', 'watch', '.']).commandPath).toEqual(['plugin', 'dev', 'watch'])
  })

  it('sends a plugin key or a host folder with the parsed payload', async () => {
    const call = vi.fn().mockResolvedValue({ result: REPLY })
    const handler = PLUGIN_DEV_EMIT_HANDLERS['plugin dev emit']!
    await handler(
      context(call, [
        'plugin',
        'dev',
        'emit',
        'acme.notes',
        'workspace.created',
        '--data',
        '{"a":1}'
      ])
    )
    expect(call).toHaveBeenCalledWith('plugins.devEmit', {
      pluginKey: 'acme.notes',
      event: 'workspace.created',
      payload: { a: 1 }
    })
    await handler(context(call, ['plugin', 'dev', 'emit', './notes', 'workspace.created']))
    expect(call).toHaveBeenLastCalledWith('plugins.devEmit', {
      path: '/work/notes',
      event: 'workspace.created',
      payload: undefined
    })
  })

  it('rejects data that is not JSON before calling the host', async () => {
    const call = vi.fn()
    await expect(
      PLUGIN_DEV_EMIT_HANDLERS['plugin dev emit']!(
        context(call, ['plugin', 'dev', 'emit', 'acme.notes', 'workspace.created', '--data', '{'])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('maps an older host to runtime_unsupported', async () => {
    const call = vi.fn().mockRejectedValue(
      new RuntimeRpcFailureError({
        id: 'req',
        ok: false,
        error: { code: 'method_not_found', message: 'unknown method' },
        _meta: { runtimeId: 'runtime_local' }
      })
    )
    await expect(
      PLUGIN_DEV_EMIT_HANDLERS['plugin dev emit']!(
        context(call, ['plugin', 'dev', 'emit', 'acme.notes', 'workspace.created'])
      )
    ).rejects.toMatchObject({ code: 'runtime_unsupported' })
  })
})
