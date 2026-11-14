import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../../arguments/args'
import { specPaths } from '../../discovery/command-spec'
import type { HandlerContext } from '../../dispatch/dispatch'
import type { RuntimeClient } from '../../runtime/client'
import { PLUGIN_VIEW_HANDLERS } from './plugin-view'

function context(argv: string[], call: ReturnType<typeof vi.fn>, cwd: string): HandlerContext {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only call client.call and read isRemote.
  const client = { call, isRemote: false } as unknown as RuntimeClient
  return { flags: parsed.flags, client, cwd, json: true, rawArgs: argv }
}

let cwd: string

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'orca-chrome-shot-'))
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(cwd, { recursive: true, force: true })
})

const shot = (argv: string[], call: ReturnType<typeof vi.fn>) =>
  PLUGIN_VIEW_HANDLERS['plugin shot']!(context(['plugin', 'shot', ...argv], call, cwd))

describe('orca plugin shot --status-bar / --window', () => {
  it('refuses both regions at once, and flags that belong to other shots', async () => {
    const call = vi.fn()
    await expect(shot(['acme.todos', '--status-bar', '--window'], call)).rejects.toThrow(
      /--status-bar or --window, not both/
    )
    await expect(shot(['acme.todos', '--window', '--panel', 'todos'], call)).rejects.toThrow(
      /--panel is not for a --window shot/
    )
    expect(call).not.toHaveBeenCalled()
  })
})
