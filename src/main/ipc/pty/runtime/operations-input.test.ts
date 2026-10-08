import { afterEach, describe, expect, it, vi } from 'vitest'
import { writePtyFromRuntimeController } from './operations'
import { bindProviderPtyInput } from '../provider/input-binding'
import { ptyInputTransactions } from '../../../runtime/pty-input-transactions'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { WRITE_ACCEPTED } from '../../../../shared/pty-write-settlement'

const { registry, bytes } = vi.hoisted(() => {
  const bytes: string[] = []
  return {
    bytes,
    registry: {
      current: {
        hasPty: (): boolean => true,
        write: (_id: string, data: string): boolean => {
          bytes.push(data)
          return true
        },
        writeWithSettlement: (_id: string, data: string) => {
          bytes.push(data)
          return WRITE_ACCEPTED
        }
      }
    }
  }
})
vi.mock('../provider/registry', () => ({
  tryGetProviderForPty: () => registry.current,
  getProviderForPty: () => registry.current
}))
vi.mock('../../../providers/local-pty-provider', () => ({ LocalPtyProvider: class {} }))
const PTY = 'operations-input'
afterEach(() => {
  bytes.length = 0
  ptyOwnership.delete(PTY)
  ptyIncarnationById.delete(PTY)
})

describe('runtime controller input funnel', () => {
  it('keeps idle input synchronous and queues forgotten writers with a narrow reply bypass', async () => {
    ptyOwnership.set(PTY, null)
    expect(writePtyFromRuntimeController({}, PTY, 'idle', 'driving')).toBe(true)
    let release: () => void = () => {}
    const active = ptyInputTransactions.run(
      bindProviderPtyInput(PTY),
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const queued = writePtyFromRuntimeController({}, PTY, 'queued', 'driving')
    const ordinary = writePtyFromRuntimeController({}, PTY, 'ordinary', 'query-reply')
    expect(writePtyFromRuntimeController({}, PTY, '\x1b[3;4R', 'query-reply')).toBe(true)
    expect(bytes).toEqual(['idle', '\x1b[3;4R'])
    release()
    await Promise.all([active, queued, ordinary])
    expect(bytes).toEqual(['idle', '\x1b[3;4R', 'queued', 'ordinary'])
    expect(ptyInputTransactions.size).toBe(0)
  })

  it('uses a supplied transaction through the controller without acquiring twice', async () => {
    await ptyInputTransactions.run(
      bindProviderPtyInput(PTY),
      (transaction) => {
        expect(transaction.write('text', 'driving')).toBe(true)
        return transaction.writeWithSettlement('\r', 'driving')
      },
      {
        writer: {
          write: (data, kind, transaction) => {
            const result = writePtyFromRuntimeController({}, PTY, data, kind, { transaction })
            if (typeof result !== 'boolean') {
              throw new Error('write must stay synchronous')
            }
            return result
          },
          writeWithSettlement: (data, kind, transaction) =>
            writePtyFromRuntimeController({}, PTY, data, kind, {
              waitForSettlement: true,
              transaction
            })
        }
      }
    )
    expect(bytes).toEqual(['text', '\r'])
    expect(ptyInputTransactions.size).toBe(0)
  })

  it('uses the reconnected provider for queued input on the same incarnation', async () => {
    ptyIncarnationById.set(PTY, 'same')
    let release: () => void = () => {}
    const active = ptyInputTransactions.run(
      bindProviderPtyInput(PTY),
      async (transaction) => {
        transaction.write('text', 'driving')
        await new Promise<void>((resolve) => {
          release = resolve
        })
        transaction.write('\r', 'driving')
      },
      {
        writer: {
          write: (data, kind, transaction) => {
            const result = writePtyFromRuntimeController({}, PTY, data, kind, { transaction })
            if (typeof result !== 'boolean') {
              throw new Error('write must stay synchronous')
            }
            return result
          }
        }
      }
    )
    const input = writePtyFromRuntimeController({}, PTY, 'queued', 'driving')
    const previous = registry.current
    const reconnectedWrite = vi.fn((_id: string, data: string) => {
      bytes.push(data)
      return true
    })
    registry.current = { ...previous, write: reconnectedWrite }
    release()
    await Promise.all([active, input])
    expect(reconnectedWrite).toHaveBeenCalledWith(PTY, 'queued')
    expect(reconnectedWrite).toHaveBeenCalledWith(PTY, '\r')
    expect(bytes).toEqual(['text', '\r', 'queued'])
    registry.current = previous
  })
})
