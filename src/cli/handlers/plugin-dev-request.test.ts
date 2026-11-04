import { describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs/index'
import { normalizeCommandPositionals, parseArgs, specPaths } from '../args'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { PLUGIN_DEV_REQUEST_HANDLERS } from './plugin-dev-request'

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

const handler = PLUGIN_DEV_REQUEST_HANDLERS['plugin dev request']!

describe('orca plugin dev request', () => {
  it('sends the plugin key, name, JSON input and timeout, waiting past the handler deadline', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { pluginKey: 'acme.notes', name: 'count', result: { count: 2 } }
    })
    await handler(
      context(call, [
        'plugin',
        'dev',
        'request',
        'acme.notes',
        'count',
        '--data',
        '{"by":1}',
        '--timeout-ms',
        '5000'
      ])
    )
    expect(call).toHaveBeenCalledWith(
      'plugins.devRequest',
      {
        pluginKey: 'acme.notes',
        name: 'count',
        input: { by: 1 },
        panel: undefined,
        timeoutMs: 5000
      },
      { timeoutMs: 35_000 }
    )
    await handler(context(call, ['plugin', 'dev', 'request', './notes', 'count']))
    expect(call).toHaveBeenLastCalledWith(
      'plugins.devRequest',
      {
        path: '/work/notes',
        name: 'count',
        input: undefined,
        panel: undefined,
        timeoutMs: undefined
      },
      { timeoutMs: 60_000 }
    )
  })

  it('rejects input that is not JSON before calling the host', async () => {
    const call = vi.fn()
    await expect(
      handler(context(call, ['plugin', 'dev', 'request', 'acme.notes', 'count', '--data', '{']))
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })
})
