import { describe, expect, it } from 'vitest'
import {
  nativeChatVisualsWritableFolders,
  withNativeChatVisualsEnv
} from './native-chat-visuals-delivery'

describe('chat storage child environment', () => {
  const inherited = {
    ORCA_CHAT_SCRATCH_DIR: '/other-chat/reports',
    ORCA_CHAT_TEMP_DIR: '/other-chat/build',
    ORCA_CHAT_VISUALS_DIR: '/legacy',
    HOME: '/home/user'
  }
  const visuals = {
    folder: '/this-chat/reports',
    temporaryFolder: '/this-chat/build',
    skill: { pluginDir: '/plugin', skillsRoot: '/plugin/skills' }
  }
  it('passes both own paths and their writable roots while preserving unrelated environment', () => {
    expect(withNativeChatVisualsEnv(inherited, visuals)).toEqual({
      HOME: '/home/user',
      ORCA_CHAT_SCRATCH_DIR: visuals.folder,
      ORCA_CHAT_TEMP_DIR: visuals.temporaryFolder
    })
    expect(nativeChatVisualsWritableFolders(visuals)).toEqual([
      visuals.folder,
      visuals.temporaryFolder
    ])
  })
  it('strips both inherited paths on unsupported launches and supports older launch inputs', () => {
    expect(withNativeChatVisualsEnv(inherited, null)).toEqual({ HOME: '/home/user' })
    expect(
      withNativeChatVisualsEnv(inherited, { folder: visuals.folder, skill: visuals.skill })
    ).toEqual({ HOME: '/home/user', ORCA_CHAT_SCRATCH_DIR: visuals.folder })
  })
})
