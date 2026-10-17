import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { StructuredAgentSessionCreateSupport } from '../native-chat/structured-agent-session-create-support'

const refreshed = vi.hoisted(() => new Set<() => void>())
vi.mock('../preflight/workspace-agent-detection', () => ({
  onAgentsRefreshedOnHost: (listener: () => void) => refreshed.add(listener)
}))

import {
  createStructuredAgentAvailability,
  installStructuredAgentAvailability
} from './structured-agent-availability'

it('publishes only complete generations, and two workspaces on one host answer apart', async () => {
  const answer = new Map<string, (support: StructuredAgentSessionCreateSupport) => void>()
  const availability = createStructuredAgentAvailability({
    agents: () => ['claude', 'pi'],
    support: (worktree, agent) => new Promise((resolve) => answer.set(worktree + agent, resolve))
  })
  const [first, second, later] = [vi.fn(), vi.fn(), vi.fn()]
  availability.subscribe('id:a', first)
  availability.subscribe('id:b', second)
  answer.get('id:aclaude')?.({ supported: true })
  answer.get('id:api')?.({ supported: true })
  answer.get('id:bclaude')?.({ supported: true })
  await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
  expect(second).not.toHaveBeenCalled()
  answer.get('id:bpi')?.({ supported: false, reason: 'agent' })
  await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1))

  expect(first.mock.calls[0][0]).toEqual([
    { agent: 'claude', state: 'available' },
    { agent: 'pi', state: 'available' }
  ])
  expect(second.mock.calls[0][0][1]).toEqual({ agent: 'pi', state: 'refused', reason: 'agent' })
  // A later reader shares the generation instead of asking again.
  availability.subscribe('id:a', later)
  expect(later).toHaveBeenCalledWith(first.mock.calls[0][0])
})

it('answers again on a launch setting change or agent refresh, and owes nothing once released', async () => {
  const listeners: ((updates: Partial<GlobalSettings>, settings: GlobalSettings) => void)[] = []
  const change = (updates: Partial<GlobalSettings>): void =>
    listeners.forEach((listener) => listener(updates, getDefaultSettings('/home/test')))
  const support = vi.fn(async () => ({ supported: true }))
  const store = {
    onSettingsChanged: (listener: (typeof listeners)[number]) => {
      listeners.push(listener)
      return () => {}
    }
  }
  const read = vi.fn()
  const release = installStructuredAgentAvailability(store, support).subscribe('id:a', read)
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  const perGeneration = support.mock.calls.length

  change({ terminalFontSize: 14 })
  change({ agentCmdOverrides: { pi: '/opt/pi' } })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  refreshed.forEach((listener) => listener())
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  release()
  change({ agentDefaultEnv: { pi: { PATH: '/opt/bin' } } })
  expect(support).toHaveBeenCalledTimes(perGeneration * 3)
})
