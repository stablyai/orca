import { afterEach, describe, expect, it, vi } from 'vitest'
import { DICTATION_CLEANUP_TIMEOUT_MS } from '../../shared/dictation-cleanup'
import {
  createMockDiscoveryChild,
  type MockDiscoveryChild
} from '../text-generation/commit-message-text-generation-test-harness'
import type * as DictationCleanup from '../../shared/dictation-cleanup'
import type * as GenerationLanes from '../text-generation/source-control-generation-lanes'
import { cancelDictationCleanup, cleanUpDictatedText } from './dictation-cleanup-service'

const children: MockDiscoveryChild[] = []
const cancelRegistrations: string[] = []
let agentId = 'claude'

vi.mock('../../shared/dictation-cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof DictationCleanup>()),
  isDictationCleanupOn: () => true
}))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  resolveTextGenerationParams: () => ({ ok: true, params: { agentId, model: 'default' } })
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: async () => ({ ok: true })
}))
vi.mock('../text-generation/source-control-generation-lanes', async (importOriginal) => {
  const actual = await importOriginal<typeof GenerationLanes>()
  return {
    ...actual,
    setLocalGenerationCancelToken: (lane: string, cancel: () => void) => {
      cancelRegistrations.push(lane)
      actual.setLocalGenerationCancelToken(lane, cancel)
    }
  }
})
vi.mock('../text-generation/source-control-agent-launch', () => ({
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
  vi.useRealTimers()
})

describe('overlapping dictation cleanups', () => {
  it.each([
    ['claude', 'skip'],
    ['claude', 'timeout'],
    // Codex runs one at a time under its home lock, so the second cleanup waits queued.
    ['codex', 'skip'],
    ['codex', 'timeout']
  ] as const)(
    '%s: a %s stops only its own agent and leaves the other cleanup running',
    async (agent, stopKind) => {
      agentId = agent
      if (stopKind === 'timeout') {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      }
      const first = cleanUpDictatedText({ text: 'first', terms: [], requestId: 'a' }, deps)
      await vi.waitFor(() => expect(children).toHaveLength(1))
      if (stopKind === 'timeout') {
        // The second cleanup starts halfway through the first one's budget.
        await vi.advanceTimersByTimeAsync(DICTATION_CLEANUP_TIMEOUT_MS / 2)
      }
      const registeredBeforeSecond = cancelRegistrations.length
      const second = cleanUpDictatedText({ text: 'second', terms: [], requestId: 'b' }, deps)
      // Stop the first only once the second can be canceled: running, or queued behind Codex's lock.
      await vi.waitFor(() =>
        expect(cancelRegistrations.length).toBeGreaterThan(registeredBeforeSecond)
      )
      expect(children).toHaveLength(agent === 'codex' ? 1 : 2)

      if (stopKind === 'skip') {
        cancelDictationCleanup('a')
      } else {
        await vi.advanceTimersByTimeAsync(DICTATION_CLEANUP_TIMEOUT_MS / 2)
      }

      await expect(first).resolves.toEqual({
        status: stopKind === 'skip' ? 'canceled' : 'timed-out'
      })
      await vi.waitFor(() => expect(children).toHaveLength(2))
      const [firstChild, secondChild] = children
      expect(firstChild.kill).toHaveBeenCalled()
      expect(secondChild.kill).not.toHaveBeenCalled()

      secondChild.stdout.emit('data', Buffer.from('Second.'))
      secondChild.emit('close', 0)
      await expect(second).resolves.toMatchObject({ status: 'cleaned', text: 'Second.' })
    }
  )
})
