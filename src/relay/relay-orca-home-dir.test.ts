import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { relayOrcaHomeDir, relayOrcaHomeDirName } from './relay-orca-home-dir'

afterEach(() => {
  delete process.env.ORCA_RELAY_HOME_DIR_NAME
})

describe('relay Orca home directory', () => {
  it('stays on ~/.orca when the client sends nothing', () => {
    expect(relayOrcaHomeDirName({})).toBe('.orca')
    expect(relayOrcaHomeDir(join('home', 'dev'), 'sessions')).toBe(
      join('home', 'dev', '.orca', 'sessions')
    )
  })

  it('follows a valid directory name from the client launch environment', () => {
    process.env.ORCA_RELAY_HOME_DIR_NAME = '.pod'
    expect(relayOrcaHomeDir(join('home', 'dev'), 'sessions')).toBe(
      join('home', 'dev', '.pod', 'sessions')
    )
  })

  it.each(['../escape', '/abs', 'plain', '.a/b', ''])('ignores %j', (value) => {
    expect(relayOrcaHomeDirName({ ORCA_RELAY_HOME_DIR_NAME: value })).toBe('.orca')
  })
})
