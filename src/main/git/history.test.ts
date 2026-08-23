import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import { getHistory } from './history'
import { gitExecFileAsync } from './runner'

vi.mock('./runner', () => ({
  gitExecFileAsync: vi.fn()
}))

const gitExecFileAsyncMock = vi.mocked(gitExecFileAsync)
const HEAD_OID = 'a'.repeat(40)
const ECHOED_PLACEHOLDER = '%(decorate:prefix=,suffix=,separator=\x1f)'

function logFormatsFromCalls(): string[] {
  return gitExecFileAsyncMock.mock.calls
    .filter(([args]) => args[0] === 'log')
    .map(([args]) => args.find((arg) => arg.startsWith('--format=')) ?? '')
}

describe('getHistory', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    clearGitCapabilityStateForTests()
    // Why: emulate Git before 2.43, which echoes the decorate placeholder and exits zero.
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const command = args[0]
      if (command === 'rev-parse' && args.includes('--symbolic-full-name')) {
        return { stdout: 'refs/heads/feature\n', stderr: '' }
      }
      if (command === 'rev-parse') {
        return { stdout: `${HEAD_OID}\n`, stderr: '' }
      }
      if (command === 'symbolic-ref') {
        return { stdout: 'feature\n', stderr: '' }
      }
      if (command === 'for-each-ref') {
        return { stdout: '\n', stderr: '' }
      }
      if (command === 'log') {
        const format = args.find((arg) => arg.startsWith('--format=')) ?? ''
        const decorations = format.includes('%(decorate:')
          ? ECHOED_PLACEHOLDER
          : 'HEAD -> refs/heads/feature'
        const record = [
          HEAD_OID,
          'Ada',
          'ada@example.com',
          '1700000000',
          '1700000000',
          '',
          decorations,
          'feat: add graph'
        ].join('\n')
        return { stdout: `${record}\0`, stderr: '' }
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })
  })

  it('recovers decorations through the local capability cache', async () => {
    const result = await getHistory('/repo')

    expect(result.items[0]?.references?.map((ref) => ref.name)).toEqual(['feature'])
    expect(logFormatsFromCalls()).toHaveLength(2)
  })

  it('probes the placeholder once per execution host', async () => {
    await getHistory('/repo')
    gitExecFileAsyncMock.mockClear()

    const result = await getHistory('/other-worktree')

    expect(result.items[0]?.references?.map((ref) => ref.name)).toEqual(['feature'])
    expect(logFormatsFromCalls()).toHaveLength(1)
    expect(logFormatsFromCalls()[0]).not.toContain('%(decorate:')
  })
})
