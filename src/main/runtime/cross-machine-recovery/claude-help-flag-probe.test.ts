import { describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '../../../shared/child-process/run-process'
import type { TuiAgent } from '../../../shared/tui-agent'
import { createClaudeHelpFlagProbe } from './claude-help-flag-probe'

const FLAG = '--append-system-prompt'
const ADVERTISED = '  --append-system-prompt <prompt>  Append a system prompt'
const UNADVERTISED = '  --system-prompt <prompt>  Replace the system prompt'

function fakeRun(stdoutByProgram: Record<string, string> = {}) {
  return vi.fn(async (spec: ProcessSpec) => ({
    code: 0,
    signal: null,
    stdout: stdoutByProgram[spec.program] ?? ADVERTISED,
    stderr: '',
    timedOut: false
  }))
}

describe('createClaudeHelpFlagProbe', () => {
  it.each([
    [ADVERTISED, true],
    [UNADVERTISED, false]
  ])('probes one command once: %s', async (stdout, advertised) => {
    const run = fakeRun({ claude: stdout })
    const probe = createClaudeHelpFlagProbe(FLAG, () => ({}), run)
    expect(await probe()).toBe(advertised)
    expect(await probe()).toBe(advertised)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each<[string, Partial<Record<TuiAgent, string>>, Partial<ProcessSpec>]>([
    ['PATH claude without an override', {}, { program: 'claude', args: ['--help'] }],
    [
      'PATH claude when only another agent is overridden',
      { codex: '/opt/codex' },
      { program: 'claude', args: ['--help'] }
    ],
    [
      'the override with its fixed args',
      { claude: '/opt/claude/bin/claude --profile work' },
      { program: '/opt/claude/bin/claude', args: ['--profile', 'work', '--help'] }
    ],
    [
      'a quoted override path with its env prefix',
      { claude: "CLAUDE_CONFIG_DIR=/tmp/cfg '/opt/my claude/claude'" },
      {
        program: '/opt/my claude/claude',
        args: ['--help'],
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/tmp/cfg' })
      }
    ]
  ])('runs %s', async (_name, overrides, spec) => {
    const run = fakeRun()
    await createClaudeHelpFlagProbe(FLAG, () => overrides, run)()
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(spec))
  })

  it('re-probes when the override changes and keeps each verdict per command', async () => {
    const run = fakeRun({ '/opt/new/claude': UNADVERTISED })
    let overrides: Partial<Record<TuiAgent, string>> = { claude: '/opt/old/claude' }
    const probe = createClaudeHelpFlagProbe(FLAG, () => overrides, run)
    expect(await probe()).toBe(true)
    overrides = { claude: '/opt/new/claude' }
    expect(await probe()).toBe(false)
    expect(await probe()).toBe(false)
    overrides = {}
    expect(await probe()).toBe(true)
    expect(run.mock.calls.map(([spec]) => spec.program)).toEqual([
      '/opt/old/claude',
      '/opt/new/claude',
      'claude'
    ])
  })

  it('reads a CLI that cannot start as unadvertised', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn claude ENOENT')
    })
    expect(await createClaudeHelpFlagProbe(FLAG, () => ({}), run)()).toBe(false)
  })

  it('reads an override it cannot tokenize as unadvertised without running it', async () => {
    const run = fakeRun()
    const probe = createClaudeHelpFlagProbe(FLAG, () => ({ claude: "'/opt/claude" }), run)
    expect(await probe()).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})
