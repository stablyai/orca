import { describe, expect, it } from 'vitest'
import { buildDockerExecArgs } from './docker-exec-command'

describe('buildDockerExecArgs', () => {
  it('builds an interactive exec with cwd and shell by default', () => {
    expect(
      buildDockerExecArgs({
        containerId: 'abc123',
        shell: '/bin/bash',
        containerCwd: '/workspaces/aprium/.worktrees/feat'
      })
    ).toEqual([
      'exec',
      '-i',
      '-t',
      '-w',
      '/workspaces/aprium/.worktrees/feat',
      'abc123',
      '/bin/bash'
    ])
  })

  it('omits the -w flag when no cwd is given', () => {
    expect(buildDockerExecArgs({ containerId: 'c', shell: 'sh', containerCwd: null })).toEqual([
      'exec',
      '-i',
      '-t',
      'c',
      'sh'
    ])
  })

  it('can disable the interactive TTY', () => {
    expect(buildDockerExecArgs({ containerId: 'c', shell: 'sh', interactive: false })).toEqual([
      'exec',
      'c',
      'sh'
    ])
  })

  it('forwards env by NAME only (never leaks secret values into argv)', () => {
    const args = buildDockerExecArgs({
      containerId: 'c',
      shell: 'bash',
      forwardEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']
    })
    expect(args).toEqual([
      'exec',
      '-i',
      '-t',
      '-e',
      'ANTHROPIC_API_KEY',
      '-e',
      'OPENAI_API_KEY',
      'c',
      'bash'
    ])
    // The secret value must not appear anywhere in argv.
    expect(args.join(' ')).not.toContain('=')
  })

  it('emits literal env as NAME=VALUE for non-secret values', () => {
    expect(
      buildDockerExecArgs({
        containerId: 'c',
        shell: 'bash',
        interactive: false,
        literalEnv: { TERM: 'xterm-256color' }
      })
    ).toEqual(['exec', '-e', 'TERM=xterm-256color', 'c', 'bash'])
  })

  it('orders flags before the container id and shell', () => {
    const args = buildDockerExecArgs({
      containerId: 'mycontainer',
      shell: '/bin/zsh',
      containerCwd: '/workspaces/x',
      forwardEnv: ['PATH_EXTRA'],
      literalEnv: { TERM: 'xterm' }
    })
    expect(args.at(-2)).toBe('mycontainer')
    expect(args.at(-1)).toBe('/bin/zsh')
    expect(args.indexOf('mycontainer')).toBeGreaterThan(args.indexOf('-w'))
  })
})
