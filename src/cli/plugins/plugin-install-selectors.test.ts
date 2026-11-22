import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { PLUGIN_INSTALL_HANDLERS } from './plugin-install'

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'orca-plugin-install-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(cwd, { recursive: true, force: true })
})

async function install(argv: string[]): Promise<unknown> {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
  const call = vi.fn().mockResolvedValue({
    result: {
      pluginKey: 'acme.notes',
      version: '1.0.0',
      previousVersion: null,
      approval: 'kept',
      source: { kind: 'local-path', path: cwd }
    }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the install handler only calls client.call and reads isRemote.
  const client = { call, isRemote: false } as unknown as RuntimeClient
  const ctx: HandlerContext = { flags: parsed.flags, client, cwd, json: true, rawArgs: argv }
  vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  await PLUGIN_INSTALL_HANDLERS['plugin install'](ctx)
  return call.mock.calls[0]?.[1]
}

describe('plugin install selectors', () => {
  it.each([
    [['acme.notes', '--ref', 'v1.0.0'], /--ref/],
    [['.', '--ref', 'v1.0.0'], /--ref/],
    [['.', '--catalog', 'community'], /--catalog/],
    [['acme/notes', '--ref'], /--ref/],
    [['acme/notes', '--ref='], /--ref/],
    [['acme.notes', '--catalog'], /--catalog/],
    [['acme.notes', '--catalog= '], /--catalog/],
    [['https://github.com/acme/notes/releases/tag/v1.4.0', '--ref', 'v2.0.0'], /version once/]
  ])('rejects %j before installing', async (args, message) => {
    await expect(install(['plugin', 'install', ...args])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringMatching(message)
    })
  })

  it.each([
    [['acme/notes', '--ref', 'v1.0.0'], { kind: 'git', input: 'acme/notes#v1.0.0' }],
    [
      ['acme.notes', '--catalog', 'community'],
      { kind: 'catalog', pluginKey: 'acme.notes', catalog: 'community' }
    ]
  ])('keeps %j', async (args, source) => {
    expect(await install(['plugin', 'install', ...args])).toMatchObject({ source })
  })
})
