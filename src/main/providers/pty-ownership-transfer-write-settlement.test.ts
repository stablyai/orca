import { expect, it } from 'vitest'
import { settleOwnershipTransferWrite } from './pty-ownership-transfer-write-settlement'

it('preserves confirmed transfer acceptance', async () => {
  await expect(settleOwnershipTransferWrite(async () => true)).resolves.toEqual({
    outcome: 'accepted'
  })
})
it.each(['false', 'throw', 'reject'])(
  'does not turn uncertain transfer %s into a retryable refusal',
  async (mode) => {
    const operation = (): Promise<boolean> => {
      if (mode === 'throw') {
        throw new Error('lost acknowledgement')
      }
      return mode === 'reject'
        ? Promise.reject(new Error('lost acknowledgement'))
        : Promise.resolve(false)
    }
    await expect(settleOwnershipTransferWrite(operation)).resolves.toMatchObject({
      outcome: 'unverifiable',
      bytesHandedToTransport: true
    })
  }
)
