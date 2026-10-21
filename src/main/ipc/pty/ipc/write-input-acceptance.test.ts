import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../../../shared/pty-write-settlement'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../shared/terminal-input'
import { PtyWriteUnavailableError } from '../../../providers/pty-write-unavailable-error'
import { ptyOwnership } from '../provider/ownership-state'
import type { PtyRendererDelivery } from '../session'
import { createPtyWriteInput } from './write-input'

const { provider } = vi.hoisted(() => ({
  provider: {
    hasPty: vi.fn(() => true),
    write: vi.fn(),
    writeWithSettlement:
      vi.fn<(id: string, data: string) => WriteSettlement | Promise<WriteSettlement>>()
  }
}))
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: () => provider }))

const id = 'pty-acceptance'
const send = vi.fn()
const mainWindow: PtyRendererDelivery = {
  isDestroyed: () => false,
  isFocused: () => true,
  isVisible: () => true,
  isMinimized: () => false,
  webContents: { id: 1, isDestroyed: () => false, send, on: vi.fn(), removeListener: vi.fn() }
}
const input = () => createPtyWriteInput({ mainWindow })
const write = (data: string) =>
  input().writePtyInputAccepted({ id, data, inputKind: 'driving', requireWriteSettlement: true })
const paneWrite = (data: string) =>
  input().writePtyInputAccepted({ id, data, inputKind: 'driving' })

beforeEach(() => {
  vi.clearAllMocks()
  provider.hasPty.mockReturnValue(true)
  provider.writeWithSettlement.mockReturnValue(WRITE_ACCEPTED)
})
afterEach(() => {
  ptyOwnership.delete(id)
})

describe('verified renderer writes reuse provider settlement', () => {
  it.each(['local', 'daemon', 'WSL', 'SSH'])(
    'waits for %s acceptance without a raw duplicate',
    async (host) => {
      ptyOwnership.set(id, host === 'SSH' ? 'ssh:connection-1' : 'local')
      let finish: (settlement: WriteSettlement) => void = () => {}
      provider.writeWithSettlement.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      let completed = false
      const pending = Promise.resolve(write('\x1b')).then((accepted) => {
        completed = true
        return accepted
      })
      await Promise.resolve()
      expect(completed).toBe(false)
      expect(provider.writeWithSettlement).toHaveBeenCalledExactlyOnceWith(id, '\x1b')
      finish(WRITE_ACCEPTED)
      await expect(pending).resolves.toBe(true)
      expect(provider.write).not.toHaveBeenCalled()
    }
  )

  it('reports proven refusal and unknown acknowledgment separately', async () => {
    ptyOwnership.set(id, 'ssh:connection-1')
    provider.writeWithSettlement.mockReturnValueOnce(writeRefused('endpoint_disconnected'))
    expect(write('1')).toBe(false)
    provider.writeWithSettlement.mockResolvedValueOnce(
      writeUnverifiable('transport_settlement_lost', true)
    )
    await expect(write('1')).rejects.toThrow('acknowledgment unavailable')
    expect(provider.write).not.toHaveBeenCalled()
  })

  it('never sends an unowned or absent PTY', () => {
    expect(write('1')).toBe(false)
    ptyOwnership.set(id, 'local')
    provider.hasPty.mockReturnValue(false)
    expect(write('1')).toBe(false)
    expect(provider.writeWithSettlement).not.toHaveBeenCalled()
  })

  it('waits for each chunk and stops a paste after refusal', async () => {
    ptyOwnership.set(id, 'ssh:connection-1')
    const paste = 'x'.repeat(TERMINAL_INPUT_CHUNK_MAX_BYTES * 2 + 1)
    provider.writeWithSettlement.mockReturnValueOnce(writeRefused('transport_queue_full'))
    await expect(write(paste)).resolves.toBe(false)
    provider.writeWithSettlement
      .mockReturnValueOnce(WRITE_ACCEPTED)
      .mockReturnValueOnce(writeRefused('transport_queue_full'))
    // An accepted prefix makes the refusal partial, matching the paired host's verdict.
    await expect(write(paste)).rejects.toThrow('acknowledgment unavailable: partial_write')
    expect(provider.writeWithSettlement).toHaveBeenCalledTimes(3)
    expect(provider.write).not.toHaveBeenCalled()
  })
})

describe('pane Escape/Ctrl+C keep the plain accepted write', () => {
  it('writes local input without waiting for settlement and refuses SSH', () => {
    ptyOwnership.set(id, 'local')
    expect(paneWrite('\x1b')).toBe(true)
    expect(provider.write).toHaveBeenCalledExactlyOnceWith(id, '\x1b')
    ptyOwnership.set(id, 'ssh:connection-1')
    expect(paneWrite('\x03')).toBe(false)
    expect(provider.writeWithSettlement).not.toHaveBeenCalled()
  })

  it('asks a pane awaiting daemon recovery to remount on either route', () => {
    ptyOwnership.set(id, 'local')
    provider.write.mockImplementationOnce(() => {
      throw new PtyWriteUnavailableError('awaiting recovery')
    })
    expect(paneWrite('\x1b')).toBe(false)
    provider.writeWithSettlement.mockReturnValueOnce(writeRefused('endpoint_awaiting_recovery'))
    expect(write('1')).toBe(false)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith('pty:writeUnavailable', { id })
  })
})
