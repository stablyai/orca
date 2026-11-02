import { encodeJiraImageFrame } from '../../../../shared/jira-image-stream-frame'
import { JIRA_IMAGE_CHUNK_BYTES } from '../../../../shared/jira-attachment-image'
import { yieldToEventLoop } from '../../../../shared/event-loop-yield'
import { throwIfSignalAborted } from '../../../../shared/abort-signal-reason'
import {
  attachmentImageGrant,
  isAttachmentImageGrantCurrent
} from '../../../jira/attachment-image-grants'
import { readGrantedAttachmentImage } from '../../../jira/attachment-image-read'
import { AttachmentImage } from '../../../../shared/rpc-contract/jira-params'
import { defineStreamingMethod } from '../core'

export const JIRA_ATTACHMENT_IMAGE_METHODS = [
  defineStreamingMethod({
    name: 'jira.attachmentImage',
    permission: 'workspace',
    params: AttachmentImage,
    handler: async ({ reference, transferId }, { sendBinary, signal }, emit) => {
      if (!sendBinary) {
        throw new Error('Jira images require a binary subscription transport.')
      }
      const grant = attachmentImageGrant(reference)
      const image = grant && (await readGrantedAttachmentImage(reference, signal))
      if (!image || !grant) {
        throw new Error('Jira image is unavailable. Reload the issue to try again.')
      }
      emit({ type: 'image', mimeType: image.mimeType, byteLength: image.data.byteLength })
      for (let offset = 0; offset < image.data.byteLength; offset += JIRA_IMAGE_CHUNK_BYTES) {
        throwIfSignalAborted(signal)
        if (!isAttachmentImageGrantCurrent(reference, grant)) {
          throw new Error('Jira image access was revoked.')
        }
        const accepted = sendBinary(
          encodeJiraImageFrame(
            transferId,
            offset / JIRA_IMAGE_CHUNK_BYTES,
            image.data.subarray(offset, offset + JIRA_IMAGE_CHUNK_BYTES)
          )
        )
        if (accepted === false || accepted === 'backlogged') {
          throw new Error('Jira image transport closed.')
        }
        await yieldToEventLoop()
      }
      throwIfSignalAborted(signal)
      if (!isAttachmentImageGrantCurrent(reference, grant)) {
        throw new Error('Jira image access was revoked.')
      }
      emit({ type: 'end' })
    }
  })
]
