import { expect, it, vi } from 'vitest'
import { OrcadDelegatedProviderAttachment } from './orcad-delegated-provider-attachment'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'

function setup() {
  const operations = {
    inspectTerminalInfo: vi.fn(async () => ({ pid: 42, cols: 80, rows: 24, initialCwd: '/host' }))
  }
  const getSnapshot = vi.fn(async (): Promise<PtyProviderBufferSnapshot | null> => ({
    source: 'headless',
    seq: 105,
    cols: 80,
    rows: 24,
    data: 'restored',
    pendingEscapeTailAnsi: '\x1b['
  }))
  const isActive = vi.fn(() => true)
  const getModelSequence = vi.fn(() => 105)
  const input = {
    runControl: vi.fn(async <T>(_id: string, operation: () => Promise<T>) => operation())
  }
  const provider = new OrcadDelegatedProviderAttachment({
    ptyId: 'pty',
    input: {
      runControl: async <T>(id: string, operation: () => Promise<T>) =>
        (await input.runControl(id, operation)) as T
    },
    operations,
    getSnapshot,
    isActive,
    getModelSequence
  })
  return { provider, operations, getSnapshot, isActive, input, getModelSequence }
}

it('attaches in the continued model sequence domain after two host inspections', async () => {
  const f = setup()
  await expect(f.provider.attach('pty')).resolves.toEqual({
    providerSequence: { value: 105, generation: 'continued' }
  })
  expect(f.operations.inspectTerminalInfo).toHaveBeenCalledTimes(2)
  expect(f.getSnapshot).toHaveBeenCalledOnce()
  expect(f.input.runControl).toHaveBeenCalledOnce()
})

it('reads runtime snapshots without contacting the source or modifying their metadata', async () => {
  const f = setup()
  await expect(f.provider.getBufferSnapshot('pty', { scrollbackRows: 123 })).resolves.toMatchObject(
    { seq: 105, pendingEscapeTailAnsi: '\x1b[' }
  )
  expect(f.getSnapshot).toHaveBeenCalledWith({ scrollbackRows: 123 })
  expect(f.operations.inspectTerminalInfo).not.toHaveBeenCalled()
})

it.each(['missing', 'changed', 'disconnected'])(
  'refuses %s host evidence after snapshot serialization',
  async (mode) => {
    const f = setup()
    f.operations.inspectTerminalInfo
      .mockImplementationOnce(async () => ({ pid: 42, cols: 80, rows: 24, initialCwd: '/host' }))
      .mockImplementationOnce(async () => {
        if (mode === 'disconnected') {
          f.isActive.mockReturnValue(false)
        }
        return mode === 'missing'
          ? (null as never)
          : { pid: mode === 'changed' ? 99 : 42, cols: 80, rows: 24, initialCwd: '/host' }
      })
    await expect(f.provider.attach('pty')).rejects.toThrow('attach_unverifiable')
  }
)

it('does not serialize a model before host liveness is available', async () => {
  const f = setup()
  f.operations.inspectTerminalInfo.mockResolvedValue(null as never)
  await expect(f.provider.attach('pty')).rejects.toThrow('attach_unverifiable')
  expect(f.getSnapshot).not.toHaveBeenCalled()
})

it('does not fabricate an attach sequence while the runtime snapshot is unavailable', async () => {
  const f = setup()
  f.getSnapshot.mockResolvedValue(null)
  await expect(f.provider.attach('pty')).rejects.toThrow('model_unavailable')
})

it('refuses an attach boundary when output advances during the final host check', async () => {
  const f = setup()
  f.getModelSequence.mockReturnValue(106)
  await expect(f.provider.attach('pty')).rejects.toThrow('attach_unverifiable')
})

it('rejects late snapshots after disconnect and requests for a different terminal', async () => {
  const f = setup()
  await expect(f.provider.getBufferSnapshot('other')).rejects.toThrow('attach_unverifiable')
  expect(f.getSnapshot).not.toHaveBeenCalled()
  f.getSnapshot.mockImplementation(async () => {
    f.isActive.mockReturnValue(false)
    return null
  })
  await expect(f.provider.getBufferSnapshot('pty')).rejects.toThrow('attach_unverifiable')
})
