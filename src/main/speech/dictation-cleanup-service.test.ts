import { afterEach, describe, expect, it, vi } from 'vitest'
import { DICTATION_CLEANUP_TIMEOUT_MS } from '../../shared/dictation-cleanup'
import {
  createMockDiscoveryChild,
  type MockDiscoveryChild
} from '../text-generation/execution/commit-message-text-generation-test-harness'
import type * as DictationCleanup from '../../shared/dictation-cleanup'
import type * as GenerationLanes from '../text-generation/execution/source-control-generation-lanes'
import { cancelDictationCleanup, cleanUpDictatedText } from './dictation-cleanup-service'

const children: MockDiscoveryChild[] = []
const cancelRegistrations: string[] = []
let agentId = 'claude'

vi.mock('../../shared/dictation-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof DictationCleanup>()),
  isDictationCleanupOn: () => true
}))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  resolveCommitMessageSettings: () => ({ ok: true, params: { agentId, model: 'default' } })
}))
vi.mock('../text-generation/execution/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: async () => ({ ok: true })
}))
vi.mock('../text-generation/execution/source-control-generation-lanes', async (importOriginal) => {
  const actual = await importOriginal<typeof GenerationLanes>()
  return {
    ...actual,
    setLocalGenerationCancelToken: (lane: string, cancel: () => void) => {
      cancelRegistrations.push(lane)
      actual.setLocalGenerationCancelToken(lane, cancel)
    }
  }
})
vi.mock('../text-generation/execution/source-control-agent-launch', () => ({
  spawnSourceControlAgent: ({ args }: { args: string[] }) => {
    const child = createMockDiscoveryChild()
    if (args.includes('mcp')) {
      // Codex's read-only policy probe: no MCP servers configured.
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('[]'))
        child.emit('close', 0)
      })
    } else {
      // A killed agent exits, as SIGKILL makes a real one do.
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
        return true
      })
      children.push(child)
    }
    return child
  }
}))

const deps = { getSettings: () => ({}), getAgentEnvResolvers: () => undefined }

afterEach(() => {
  children.length = 0
  cancelRegistrations.length = 0
  agentId = 'claude'
  vi.useRealTimers()
})

function startCleanup(requestId: string): ReturnType<typeof cleanUpDictatedText> {
  return cleanUpDictatedText({ text: requestId, terms: [], requestId }, deps)
}

/** Starts a cleanup and returns once it can be canceled: its agent running, or queued for one. */
async function startCancelableCleanup(
  requestId: string
): Promise<{ cleanup: ReturnType<typeof cleanUpDictatedText> }> {
  const registeredBefore = cancelRegistrations.length
  const cleanup = startCleanup(requestId)
  await vi.waitFor(() => expect(cancelRegistrations.length).toBeGreaterThan(registeredBefore))
  return { cleanup }
}

async function expectSecondAgentToFinish(
  second: ReturnType<typeof cleanUpDictatedText>
): Promise<void> {
  await vi.waitFor(() => expect(children).toHaveLength(2))
  const [firstAgent, secondAgent] = children
  expect(firstAgent.kill).toHaveBeenCalled()
  expect(secondAgent.kill).not.toHaveBeenCalled()
  secondAgent.stdout.emit('data', Buffer.from('Second.'))
  secondAgent.emit('close', 0)
  await expect(second).resolves.toMatchObject({ status: 'cleaned', text: 'Second.' })
}

describe('overlapping dictation cleanups share a folder but stop independently', () => {
  it('skipping the first stops only its agent while the second keeps running', async () => {
    const first = startCleanup('a')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const { cleanup: second } = await startCancelableCleanup('b')
    expect(children).toHaveLength(2)

    cancelDictationCleanup('a')

    await expect(first).resolves.toEqual({ status: 'canceled' })
    await expectSecondAgentToFinish(second)
  })

  it('the first timing out stops only its agent while the second keeps running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = startCleanup('a')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(DICTATION_CLEANUP_TIMEOUT_MS / 2)
    const { cleanup: second } = await startCancelableCleanup('b')
    expect(children).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(DICTATION_CLEANUP_TIMEOUT_MS / 2)

    await expect(first).resolves.toEqual({ status: 'timed-out' })
    await expectSecondAgentToFinish(second)
  })

  // Codex runs one at a time under its home lock, so the second cleanup waits queued.
  it('skipping a running Codex cleanup lets the queued one start and finish', async () => {
    agentId = 'codex'
    const first = startCleanup('a')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const { cleanup: second } = await startCancelableCleanup('b')
    expect(children).toHaveLength(1)

    cancelDictationCleanup('a')

    await expect(first).resolves.toEqual({ status: 'canceled' })
    await expectSecondAgentToFinish(second)
  })

  it('a running Codex cleanup timing out lets the queued one start and finish', async () => {
    agentId = 'codex'
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = startCleanup('a')
    await vi.waitFor(() => expect(children).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(DICTATION_CLEANUP_TIMEOUT_MS / 2)
    const { cleanup: second } = await startCancelableCleanup('b')
    expect(children).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(DICTATION_CLEANUP_TIMEOUT_MS / 2)

    await expect(first).resolves.toEqual({ status: 'timed-out' })
    await expectSecondAgentToFinish(second)
  })
})
