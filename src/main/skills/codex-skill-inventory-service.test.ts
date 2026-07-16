import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'

const { child, stdinWrite } = vi.hoisted(() => {
  function emitter() {
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
    return {
      on(event: string, listener: (...args: unknown[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args)
        }
      }
    }
  }
  const stdout = emitter()
  const process = Object.assign(emitter(), {
    stdout,
    stderr: emitter(),
    stdin: { write: vi.fn() },
    kill: vi.fn()
  })
  return { child: process, stdinWrite: process.stdin.write }
})

vi.mock('node:child_process', () => ({ spawn: vi.fn(() => child) }))
vi.mock('../codex-cli/command', () => ({ resolveCodexCommand: () => 'codex' }))
vi.mock('../win32-utils', () => ({
  getSpawnArgsForWindows: (command: string, args: string[]) => ({
    spawnCmd: command,
    spawnArgs: args
  })
}))

import { CodexSkillInventoryService } from './codex-skill-inventory-service'

describe('CodexSkillInventoryService', () => {
  beforeEach(() => {
    stdinWrite.mockReset()
    vi.mocked(spawn).mockClear()
  })

  it('uses skills/list for the requested cwd and forwards watcher invalidation', async () => {
    const service = new CodexSkillInventoryService('/profiles/active-codex-home')
    const changed = vi.fn()
    service.on('changed', changed)
    stdinWrite.mockImplementation((line: string) => {
      const message = JSON.parse(line) as { id?: number; method: string }
      if (message.method === 'initialize') {
        queueMicrotask(() =>
          child.stdout.emit(
            'data',
            Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)
          )
        )
      } else if (message.method === 'skills/list') {
        queueMicrotask(() =>
          child.stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                id: message.id,
                result: {
                  data: [
                    {
                      cwd: '/repo',
                      errors: [],
                      skills: [
                        {
                          name: 'plugin:active',
                          description: 'Active',
                          path: '/cache/plugin/2/skills/active/SKILL.md',
                          scope: 'user',
                          enabled: true
                        }
                      ]
                    }
                  ]
                }
              })}\n`
            )
          )
        )
      }
      return true
    })

    await expect(service.list('/repo')).resolves.toEqual([
      expect.objectContaining({ name: 'plugin:active' })
    ])
    expect(vi.mocked(spawn).mock.calls[0]?.[2]?.env).toMatchObject({
      CODEX_HOME: '/profiles/active-codex-home'
    })
    expect(
      stdinWrite.mock.calls
        .map(([line]) => JSON.parse(line as string))
        .find((message) => message.method === 'skills/list')
    ).toMatchObject({ params: { cwds: ['/repo'], forceReload: false } })

    child.stdout.emit('data', Buffer.from('{"method":"skills/changed","params":{}}\n'))
    expect(changed).toHaveBeenCalledOnce()
    service.dispose()
  })
})
