import { describe, expect, it } from 'vitest'
import { buildDiscordPresenceActivity } from './discord-presence-activity'

const translate = (_key: string, fallback: string, options?: { count: number }): string =>
  options ? fallback.replace('{{count}}', String(options.count)) : fallback

function build(workingAgentCount: number, waitingAgentCount: number) {
  return buildDiscordPresenceActivity(
    { workingAgentCount, waitingAgentCount, sessionStartedAt: 1_700_000_000_000 },
    translate
  )
}

describe('buildDiscordPresenceActivity', () => {
  it('shows idle with the session timer when no agent is active', () => {
    const activity = build(0, 0)
    expect(activity.details).toBe('Idle')
    expect(activity.state).toBeUndefined()
    expect(activity.timestamps).toEqual({ start: 1_700_000_000_000 })
    expect(activity.assets?.large_image).toBe('orca')
  })

  it('counts working agents with singular and plural copy', () => {
    expect(build(1, 0).details).toBe('Running 1 agent')
    expect(build(3, 0).details).toBe('Running 3 agents')
  })

  it('adds waiting agents as the second line while others work', () => {
    const activity = build(2, 1)
    expect(activity.details).toBe('Running 2 agents')
    expect(activity.state).toBe('1 agent waiting for input')
  })

  it('leads with waiting agents when nothing is working', () => {
    const activity = build(0, 2)
    expect(activity.details).toBe('2 agents waiting for input')
    expect(activity.state).toBeUndefined()
  })
})
