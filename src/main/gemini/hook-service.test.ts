import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as OsModule from 'node:os'
import { join } from 'node:path'
import { GeminiHookService } from './hook-service'

const { homeMock } = vi.hoisted(() => ({ homeMock: vi.fn<() => string>() }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof OsModule>()),
  homedir: homeMock
}))

let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-gemini-hook-'))
  homeMock.mockReturnValue(home)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function installedAfterAgentCommand(): string {
  expect(new GeminiHookService().install().state).toBe('installed')
  const settings: { hooks: Record<string, { hooks: { command: string }[] }[]> } = JSON.parse(
    readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')
  )
  return settings.hooks.AfterAgent[0].hooks[0].command
}

function runHook(command: string, paneEnv: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: home, ...paneEnv }
  return spawnSync('/bin/sh', ['-c', command], {
    env,
    input: '{"hook_event_name":"AfterAgent"}',
    encoding: 'utf8',
    timeout: 5000
  })
}

describe.skipIf(process.platform === 'win32')('Gemini installed hook command', () => {
  it('skips the managed script outside an Orca pane and runs it inside one', () => {
    const command = installedAfterAgentCommand()
    const marker = join(home, 'script-ran')
    writeFileSync(
      join(home, '.orca', 'agent-hooks', 'gemini-hook.sh'),
      `#!/bin/sh\ncat >/dev/null\n: > '${marker}'\nprintf '{}\\n'\n`
    )

    const outside = runHook(command, {})
    expect(outside.status).toBe(0)
    expect(outside.stdout).toBe('{}\n')
    expect(existsSync(marker)).toBe(false)

    const inside = runHook(command, { ORCA_PANE_KEY: 'tab-1:leaf-1' })
    expect(inside.status).toBe(0)
    expect(existsSync(marker)).toBe(true)
  })
})
