import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { describe, expect, it } from 'vitest'
import type { SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { PipedProcessSpawner, ProcessSpec } from '@orca/process-host/process-spec'

import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'

function fakeSpawn() {
  const child = createFakePipedChild()
  const specs: ProcessSpec[] = []
  const spawnImpl: PipedProcessSpawner = (spec) => {
    specs.push(spec)
    return child
  }
  return { child, spawnImpl, specs }
}

function sdkOptions(overrides: Partial<SdkSpawnOptions> = {}): SdkSpawnOptions {
  return {
    command: '/usr/local/bin/claude',
    args: ['--output-format', 'stream-json'],
    cwd: '/work/repo',
    env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/accounts/one', UNSET: undefined },
    signal: new AbortController().signal,
    ...overrides
  }
}

describe('claude agent SDK process spawn', () => {
  it('routes the SDK spawn through Orca and retains the pid the lease adjudicates on', () => {
    const process = fakeSpawn()
    const spawn = createClaudeCodeProcessSpawn(process.spawnImpl, 'win32')

    expect(spawn.pid).toBeUndefined()
    expect(spawn.child).toBeNull()
    const child = spawn.spawn(sdkOptions())

    expect(child).toBe(process.child)
    expect(spawn.child).toBe(process.child)
    expect(spawn.pid).toBe(4321)
    // Windows has no supervisor: Claude itself is the child.
    expect(spawn.dedicatedGroup).toBe(false)
    expect(process.specs[0]).toEqual({
      program: '/usr/local/bin/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/work/repo',
      env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/accounts/one' },
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  })

  it.each(['darwin', 'linux'] as const)('returns the actual direct CLI child on %s', (platform) => {
    const fixture = fakeSpawn()
    const spawner = createClaudeCodeProcessSpawn(fixture.spawnImpl, platform)
    expect(spawner.spawn(sdkOptions())).toBe(fixture.child)
    expect(spawner.pid).toBe(fixture.child.pid)
    expect(fixture.specs[0]).toMatchObject({
      program: '/usr/local/bin/claude',
      args: ['--output-format', 'stream-json'],
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/accounts/one' }
    })
  })
})
