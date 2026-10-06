import { describe, expect, it } from 'vitest'
import { discoverLiteralProfileAlias } from './literal-alias'

const context = {
  commandName: 'claude',
  executable: '/opt/bin/claude',
  homeVariable: 'CLAUDE_CONFIG_DIR',
  hostHome: '/home/person',
  platform: 'linux' as const
}
const declaration = `alias claude2='CLAUDE_CONFIG_DIR="$HOME/.claude-second" claude'`

describe('literal profile aliases', () => {
  it('recognizes the existing claude2 definition without sourcing the file', () => {
    expect(
      discoverLiteralProfileAlias(
        'claude2',
        [{ name: '.zsh_aliases', content: `# Personal aliases\n${declaration} # Work account\n` }],
        context
      )
    ).toEqual({
      kind: 'resolved',
      executable: '/opt/bin/claude',
      home: '/home/person/.claude-second',
      homeVariable: 'CLAUDE_CONFIG_DIR',
      source: '.zsh_aliases'
    })
  })

  it('uses the same discovery for a Codex alias', () => {
    expect(
      discoverLiteralProfileAlias(
        'codex-work',
        [{ name: '.bash_aliases', content: `alias codex-work='CODEX_HOME=~/codex-work codex'` }],
        {
          ...context,
          commandName: 'codex',
          executable: '/opt/bin/codex',
          homeVariable: 'CODEX_HOME'
        }
      )
    ).toMatchObject({
      kind: 'resolved',
      home: '/home/person/codex-work',
      homeVariable: 'CODEX_HOME'
    })
  })

  it.each([
    '',
    `if test -e /something; then\n${declaration}\nfi`,
    `setup() {\n${declaration}\n}`,
    `source ~/.other-aliases\n${declaration}`,
    `cat <<'EOF'\n${declaration}\nEOF`,
    `${declaration}\n${declaration}`,
    `${declaration}#not-a-shell-comment`,
    `\u00a0${declaration}`,
    `alias claude2='claude3'\nalias claude3='CLAUDE_CONFIG_DIR=/profiles/work claude'`,
    `${declaration}\nalias claude='some-wrapper'`,
    `alias alias='echo'\n${declaration}`,
    `${declaration}\r\n`,
    `alias claude2='CLAUDE_CONFIG_DIR=$(touch /tmp/probe) claude'`,
    `alias claude2="CLAUDE_CONFIG_DIR=$HOME/second claude"`,
    `alias claude2='CLAUDE_CONFIG_DIR=/profiles/work claude --model sonnet'`
  ])('requires folder selection when alias meaning is uncertain: %s', (content) => {
    expect(
      discoverLiteralProfileAlias('claude2', [{ name: '.zshrc', content }], context).kind
    ).toBe('needs-path')
  })

  it('refuses conflicting definitions across candidate files', () => {
    expect(
      discoverLiteralProfileAlias(
        'claude2',
        [
          { name: '.zshrc', content: declaration },
          { name: '.zsh_aliases', content: declaration }
        ],
        context
      ).kind
    ).toBe('needs-path')
  })

  it('bounds the supplied text and refuses shell expressions as alias names', () => {
    const sources = [{ name: '.zshrc', content: declaration }]
    expect(discoverLiteralProfileAlias('$(touch /tmp/probe)', sources, context).kind).toBe(
      'needs-path'
    )
    expect(
      discoverLiteralProfileAlias(
        'claude2',
        [{ name: '.zshrc', content: `${'#'.repeat(1024 * 1024 + 1)}\n${declaration}` }],
        context
      ).kind
    ).toBe('needs-path')
    expect(discoverLiteralProfileAlias('claude2', Array(5).fill(sources[0]), context).kind).toBe(
      'needs-path'
    )
  })
})
