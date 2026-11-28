import { expect, it } from 'vitest'
import { countClaudeSessions, DEFAULT_SESSION_KEY } from './claude-rotation-sessions'

const ROOT = '/Users/x/Library/Application Support/orca/claude-profiles'

it('counts each Claude process under the folder whose keychain slot it uses', () => {
  const comm = [
    '  101 claude',
    '  102 /Users/x/.local/share/claude/versions/2.1.0',
    '  103 node',
    '  104 claude',
    '  105 claude'
  ].join('\n')
  const env = [
    // Orca's agent view sets ORCA_CLAUDE_CONFIG_DIR, which must not be read as CLAUDE_CONFIG_DIR.
    `  101 claude --resume ORCA_CLAUDE_CONFIG_DIR=/Users/x/.claude CLAUDE_CONFIG_DIR=${ROOT}/a1/home PATH=/bin`,
    `  102 claude CLAUDE_CONFIG_DIR=${ROOT}/a1/home ORCA_CLAUDE_CONFIG_DIR=/Users/x/.claude`,
    `  103 node CLAUDE_CONFIG_DIR=${ROOT}/b2/home`,
    `  104 claude CLAUDE_CONFIG_DIR=${ROOT}/a1/home CLAUDE_SECURESTORAGE_CONFIG_DIR=${ROOT}/b2/home`,
    '  105 claude ORCA_CLAUDE_CONFIG_DIR=/Users/x/.claude TERM=xterm'
  ].join('\n')
  expect(countClaudeSessions(comm, env, ROOT)).toEqual(
    new Map([
      [`${ROOT}/a1/home`, 2],
      [`${ROOT}/b2/home`, 1],
      [DEFAULT_SESSION_KEY, 1]
    ])
  )
})

it('reports sessions as uncounted when a Claude process has no environment line', () => {
  // Process 202 started after the environments were read.
  const comm = ['  201 claude', '  202 claude'].join('\n')
  const env = `  201 claude CLAUDE_CONFIG_DIR=${ROOT}/a1/home`
  expect(countClaudeSessions(comm, env, ROOT)).toBeNull()
})
