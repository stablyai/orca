import { createLocalLifecycleProvider } from './local-lifecycle-routing'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import { describe, expect, it } from 'vitest'
import { selectLocalPtyBackend } from './backend-routing'
import { getLocalPtyBackendId } from '../../../../shared/terminal/pty/lifecycle/pty-backend-id'

describe('local backend identity', () => {
  it('keeps default and existing workspace ids on the existing route', () => {
    for (const id of [
      undefined,
      '1',
      'a6e5a276-2cfa-407d-b167-7a950354cf18',
      'repo::/tmp/rex-project@@12345678',
      'repo::/tmp/rex-project@@serve-a'
    ]) {
      expect(getLocalPtyBackendId(id)).toBe('default')
    }
  })

  it('never treats an unavailable Rex backend as a standard owner absence proof', async () => {
    const standard = new LocalPtyProvider()
    const lifecycle = createLocalLifecycleProvider(standard)
    await expect(lifecycle.listProcesses({ ptyIds: ['rex-missing'] })).rejects.toThrow(
      'backend unavailable'
    )
    await expect(lifecycle.probePtyLiveness?.('rex-missing')).resolves.toBeNull()
    expect(() => lifecycle.shutdown('rex-missing', {})).toThrow('saved session was not replaced')
  })

  it('reserves Rex ids including workspace qualified ids and fails closed when unavailable', () => {
    const standard = { name: 'default' }
    const rex = { name: 'rex' }
    expect(selectLocalPtyBackend(undefined, standard, rex)).toBe(standard)
    for (const id of ['rex-a', 'repo::/tmp/project@@rex-b']) {
      expect(getLocalPtyBackendId(id)).toBe('rex')
      expect(() => selectLocalPtyBackend(id, standard)).toThrow('saved session was not replaced')
      expect(selectLocalPtyBackend(id, standard, rex)).toBe(rex)
    }
  })
})
