import { describe, expect, it } from 'vitest'
import { resolveBareAgentLaunchCommand, resolveLaunchCommandPaneAgent } from './runtime-agent-launch-resolution'

const settings = { agentCmdOverrides: {}, disabledTuiAgents: [] }

describe('resolveBareAgentLaunchCommand', () => {
  it('matches only the exact bare launch command', () => {
    expect(resolveBareAgentLaunchCommand({ command: 'omp', settings, platform: 'darwin', isRemote: false })).toBe(
      'omp'
    )
    // Why: a flagged command stays user-authored shell — the managed-launch lane must not rewrite it.
    expect(
      resolveBareAgentLaunchCommand({ command: 'omp --model x', settings, platform: 'darwin', isRemote: false })
    ).toBeNull()
  })
})

describe('resolveLaunchCommandPaneAgent', () => {
  it('names the agent a flagged interactive launch belongs to', () => {
    expect(resolveLaunchCommandPaneAgent('omp --model x')).toBe('omp')
    expect(resolveLaunchCommandPaneAgent('omp')).toBe('omp')
  })

  it('keeps the headless one-shot filter', () => {
    expect(resolveLaunchCommandPaneAgent('claude -p hi')).toBeNull()
  })

  it('answers non-TuiAgent recognitions as null', () => {
    expect(resolveLaunchCommandPaneAgent('dsb serve')).toBeNull()
  })

  it('answers non-agent commands as null', () => {
    expect(resolveLaunchCommandPaneAgent('echo hello')).toBeNull()
    expect(resolveLaunchCommandPaneAgent(undefined)).toBeNull()
  })
})
