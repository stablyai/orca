import { describe, expect, it } from 'vitest'
import { parseProfileCommand } from './command'

const claude = {
  commandName: 'claude',
  executable: '/opt/Claude CLI/claude',
  homeVariable: 'CLAUDE_CONFIG_DIR',
  hostHome: '/home/person',
  platform: 'linux' as const
}

describe('profile command discovery', () => {
  it.each(['/opt/$TOOLS/claude', '/opt/*/claude', '/opt/[ab]/claude'])(
    'rejects executable expansion while accepting a quoted literal: %s',
    (executable) => {
      const context = { ...claude, executable }
      expect(parseProfileCommand(`CLAUDE_CONFIG_DIR=/work ${executable}`, context).kind).toBe(
        'needs-path'
      )
      expect(parseProfileCommand(`CLAUDE_CONFIG_DIR=/work '${executable}'`, context).kind).toBe(
        'resolved'
      )
    }
  )

  it.each([
    ['CLAUDE_CONFIG_DIR=/profiles/work claude', '/profiles/work'],
    ['CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude', '/home/person/.claude-second'],
    ['CLAUDE_CONFIG_DIR=${HOME}/.claude-second claude', '/home/person/.claude-second'],
    ['CLAUDE_CONFIG_DIR=~/.claude-second claude', '/home/person/.claude-second'],
    [
      'CLAUDE_CONFIG_DIR="/profiles/Work Account" "/opt/Claude CLI/claude"',
      '/profiles/Work Account'
    ],
    ["CLAUDE_CONFIG_DIR='/profiles/$literal' claude", '/profiles/$literal']
  ])('extracts an explicit home without running %s', (command, home) => {
    expect(parseProfileCommand(command, claude)).toEqual({
      kind: 'resolved',
      executable: '/opt/Claude CLI/claude',
      home,
      homeVariable: 'CLAUDE_CONFIG_DIR'
    })
  })

  it('uses the registered provider home variable for Codex', () => {
    expect(
      parseProfileCommand('CODEX_HOME=~/codex-work codex', {
        ...claude,
        commandName: 'codex',
        executable: '/opt/bin/codex',
        homeVariable: 'CODEX_HOME'
      })
    ).toEqual({
      kind: 'resolved',
      executable: '/opt/bin/codex',
      home: '/home/person/codex-work',
      homeVariable: 'CODEX_HOME'
    })
  })

  it.each([
    'claude',
    'CLAUDE_CONFIG_DIR= claude',
    'CLAUDE_CONFIG_DIR=relative claude',
    'CLAUDE_CONFIG_DIR="$OTHER/work" claude',
    "CLAUDE_CONFIG_DIR='$HOME/work' claude",
    'CLAUDE_CONFIG_DIR="~/work" claude',
    'CLAUDE_CONFIG_DIR=/profiles/work /untrusted/claude',
    'CLAUDE_CONFIG_DIR=/profiles/work claude --resume',
    'OTHER=/profiles/work claude',
    'env CLAUDE_CONFIG_DIR=/profiles/work claude',
    'CLAUDE_CONFIG_DIR=/profiles/work claude; touch /tmp/probe',
    'CLAUDE_CONFIG_DIR=$(touch /tmp/probe) claude',
    'CLAUDE_CONFIG_DIR="`touch /tmp/probe`" claude',
    'CLAUDE_CONFIG_DIR=/profiles/* claude',
    'CLAUDE_CONFIG_DIR=/profiles:~/work claude',
    'CLAUDE_CONFIG_DIR=$HOME:~/work claude',
    'CLAUDE_CONFIG_DIR="/profiles/work claude',
    'CLAUDE_CONFIG_DIR=/profiles/work\nclaude',
    'CLAUDE_CONFIG_DIR=/profiles/work\u00a0claude',
    'CLAUDE_CONFIG_DIR=/profiles/work\\ claude',
    'x'.repeat(4097)
  ])('offers folder selection for ambiguous or unsupported input: %s', (command) => {
    expect(parseProfileCommand(command, claude).kind).toBe('needs-path')
  })

  it('does not interpret a POSIX command as a Windows launch', () => {
    expect(
      parseProfileCommand('CLAUDE_CONFIG_DIR=/profiles/work claude', {
        ...claude,
        platform: 'win32'
      }).kind
    ).toBe('needs-path')
  })
})
