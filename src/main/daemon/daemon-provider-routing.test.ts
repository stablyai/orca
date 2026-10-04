import { describe, expect, it } from 'vitest'
import { getLegacyDaemonAdapters } from './daemon-provider-routing'
import { LocalPtyProvider } from '../providers/local-pty-provider'

describe('getLegacyDaemonAdapters', () => {
  it('lists none for the in-process fallback provider', () => {
    expect(getLegacyDaemonAdapters(new LocalPtyProvider())).toEqual([])
  })
})
