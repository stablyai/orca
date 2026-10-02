import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeCliCommandResolution from '../shared/node-cli-command-resolution'
import { REPEATED_FLAG_SEPARATOR } from './args'
import type { HandlerContext } from './dispatch'
import type { RuntimeClient } from './runtime-client'

const { resolveCliCommandMock, spawnMock } = vi.hoisted(() => ({
  resolveCliCommandMock: vi.fn(() => 'npx'),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

// Why: only the npx lookup is pinned, so the real argv-building rails still run.
vi.mock('../shared/node-cli-command-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeCliCommandResolution>()),
  resolveCliCommand: resolveCliCommandMock
}))

import { SKILL_HANDLERS } from './handlers/skills'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the skills handlers never touch the client; it is only here because HandlerContext requires one, and a never-called `call` is the whole surface.
const client = { call: vi.fn() } as unknown as RuntimeClient

function context(flags: [string, string | boolean][]): HandlerContext {
  return { client, cwd: '/tmp/repo', flags: new Map(flags), json: false, rawArgs: [] }
}

/**
 * A scratch HOME shaped like orca#22897: the Claude provider root links at a dotfiles
 * tree that keeps a real `orca-cli/`. `npx skills update` deletes that directory and
 * leaves a shortcut resolving nowhere, so the name must never reach the argv.
 * See src/main/skills/skill-linked-root-deletion.ts.
 */
function linkedRootHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'orca-cli-linked-root-'))
  mkdirSync(join(home, 'dotfiles', 'skills', 'orca-cli'), { recursive: true })
  writeFileSync(join(home, 'dotfiles', 'skills', 'orca-cli', 'SKILL.md'), '# orca-cli\n')
  mkdirSync(join(home, '.claude'), { recursive: true })
  // A junction on Windows: what Orca writes there, and it needs no elevation.
  symlinkSync(
    join(home, 'dotfiles', 'skills'),
    join(home, '.claude', 'skills'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
}

beforeEach(() => {
  spawnMock.mockReset()
  resolveCliCommandMock.mockReset().mockReturnValue('npx')
  // Set on a forwarding shell, where the handler refuses before it reads any root.
  vi.stubEnv('ORCA_CLI_CWD', undefined)
  process.exitCode = undefined
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = undefined
})

describe('orca skills update in a linked agent skills root', () => {
  it('leaves the skill out of the command and says why on stderr', async () => {
    linkedRootHome()
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child)
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    // Why the separator: repeated `--skill` flags collapse into one Map entry.
    const finished = SKILL_HANDLERS['skills update'](
      context([['skill', `orca-cli${REPEATED_FLAG_SEPARATOR}orchestration`]])
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await finished

    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      '--yes',
      'skills',
      'update',
      'orchestration',
      '--global',
      '-y'
    ])
    // Why stderr rather than silence: the whole point is that the user can act on it.
    expect(stderrSpy.mock.calls.map((call) => String(call[0])).join('')).toContain(
      'Skipped orca-cli:'
    )
  })

  it('runs nothing, and fails nothing, when every name is at risk', async () => {
    linkedRootHome()
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await SKILL_HANDLERS['skills update'](
      context([
        ['skill', 'orca-cli'],
        ['dry-run', true]
      ])
    )

    expect(stdoutSpy.mock.calls.map((call) => String(call[0])).join('')).toBe(
      'Nothing left to update: every skill named was skipped.\n'
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('still installs into a linked root, where replacing the directory is the request', async () => {
    linkedRootHome()
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const finished = SKILL_HANDLERS['skills install'](
      context([
        ['skill', 'orca-cli'],
        ['agent', 'claude-code']
      ])
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await finished

    expect(spawnMock.mock.calls[0]?.[1]).toContain('orca-cli')
  })

  it('still updates the skill when no agent skills root is a link', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-cli-real-root-'))
    mkdirSync(join(home, '.claude', 'skills', 'orca-cli'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'orca-cli', 'SKILL.md'), '# orca-cli\n')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const finished = SKILL_HANDLERS['skills update'](context([['skill', 'orca-cli']]))
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 0, null)
    await finished

    expect(spawnMock.mock.calls[0]?.[1]).toContain('orca-cli')
  })
})
