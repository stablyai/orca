// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { claimMobileComposerImagePaste } from './mobile-native-chat-composer-image-paste-claim.web'

function transfer(files: readonly File[], text = ''): DataTransfer {
  const data = new DataTransfer()
  for (const file of files) {
    data.items.add(file)
  }
  if (text.length > 0) {
    data.setData('text/plain', text)
  }
  return data
}

describe('claimMobileComposerImagePaste', () => {
  it('keeps a PNG, counts a skipped HEIC, and drops filename-only text', () => {
    const claimed = claimMobileComposerImagePaste(
      transfer(
        [
          new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }),
          new File([new Uint8Array([2])], 'shot.heic', { type: 'image/heic' })
        ],
        'shot.png\nshot.heic'
      )
    )

    expect(claimed?.kind).toBe('files')
    if (claimed?.kind !== 'files') {
      return
    }
    expect(claimed.files.map((file) => file.type)).toEqual(['image/png'])
    expect(claimed.skippedCount).toBe(1)
    expect(claimed.promptText).toBe('')
  })

  it('does not report a skip when every pasted file is supported', () => {
    const claimed = claimMobileComposerImagePaste(
      transfer([new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })])
    )

    expect(claimed).toMatchObject({ kind: 'files', skippedCount: 0 })
  })

  it('leaves a HEIC-only paste unclaimed', () => {
    expect(
      claimMobileComposerImagePaste(
        transfer([new File([new Uint8Array([2])], 'shot.heic', { type: 'image/heic' })])
      )
    ).toBeNull()
  })
})
