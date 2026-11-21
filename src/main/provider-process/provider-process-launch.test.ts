import { describe, expect, it } from 'vitest'
import { resolveProviderChildEnv } from './provider-process-launch'

describe('a provider child environment', () => {
  it('removes a differently cased inherited key on Windows', () => {
    expect(
      resolveProviderChildEnv(
        { envToDelete: ['ORCA_CHAT_TEMP_DIR'] },
        { orca_chat_temp_dir: '/other-chat/build', Path: 'C:\\bin' },
        'win32'
      )
    ).toEqual({ Path: 'C:\\bin' })
  })
})
