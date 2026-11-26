import { expect, it } from 'vitest'
import { cancelRuntimeUpload, trackRuntimeUpload } from './runtime-upload-tracking'

const sender = (id: number) => ({ id, send: () => {}, isDestroyed: () => false })

it('cancels only the starting window’s running upload and never remembers a cancel', () => {
  const upload = trackRuntimeUpload(sender(1), 'upload-a')
  cancelRuntimeUpload(2, 'upload-a')
  expect(upload.signal.aborted).toBe(false)

  cancelRuntimeUpload(1, 'upload-a')
  expect(upload.signal.aborted).toBe(true)
  upload.end()

  cancelRuntimeUpload(1, 'upload-b')
  const later = trackRuntimeUpload(sender(1), 'upload-b')
  expect(later.signal.aborted).toBe(false)
  later.end()
})
