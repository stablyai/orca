import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { orcaHomeDir, orcaHomeDirIn } from './orca-home-dir'

describe('orcaHomeDir', () => {
  it('resolves ~/.orca on this computer', () => {
    expect(orcaHomeDir()).toBe(join(homedir(), '.orca'))
    expect(orcaHomeDir('agent-hooks', 'claude-hook.sh')).toBe(
      join(homedir(), '.orca', 'agent-hooks', 'claude-hook.sh')
    )
  })

  it('uses an injected home for callers that pass one', () => {
    expect(orcaHomeDirIn(join('home', 'dev'), 'keybindings.json')).toBe(
      join('home', 'dev', '.orca', 'keybindings.json')
    )
  })
})
