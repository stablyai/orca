import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnOptions as SdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import type { PipedProcessSpawner, ProcessSpec } from '@orca/process-host/process-spec'

import type * as ProviderSupervisor from '../../provider-process/provider-process-supervisor'

import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'

vi.mock('../../provider-process/provider-process-supervisor', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderSupervisor>()
  return { ...actual, createProviderSpawnSpec: vi.fn(actual.createProviderSpawnSpec) }
})

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
  it('keeps native chat identity after SDK and configured environment defaults', () => {
    const process = fakeSpawn()
    createClaudeCodeProcessSpawn(process.spawnImpl, 'win32').spawn(
      sdkOptions({
        env: {
          CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
          claude_code_entrypoint: 'account',
          PATH: 'C:\\bin'
        }
      })
    )
    expect(process.specs[0]?.env).toMatchObject({ CLAUDE_CODE_ENTRYPOINT: 'orca', PATH: 'C:\\bin' })
    expect(
      Object.keys(process.specs[0]?.env ?? {}).filter(
        (key) => key.toUpperCase() === 'CLAUDE_CODE_ENTRYPOINT'
      )
    ).toEqual(['CLAUDE_CODE_ENTRYPOINT'])
  })

  it('preserves a Windows .cmd shim and its arguments for the host spawner', () => {
    const process = fakeSpawn()
    createClaudeCodeProcessSpawn(process.spawnImpl, 'win32').spawn(
      sdkOptions({
        command: 'C:\\Users\\dev\\AppData\\npm\\claude.cmd',
        args: ['--setting-sources=user,project,local', '--session-id', 'a b&c']
      })
    )

    expect(process.specs).toEqual([
      expect.objectContaining({
        program: 'C:\\Users\\dev\\AppData\\npm\\claude.cmd',
        args: ['--setting-sources=user,project,local', '--session-id', 'a b&c']
      })
    ])
  })
})
