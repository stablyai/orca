import { describe, expect, it } from 'vitest'
import { MEDIA_HANDOFF_MIME_TYPES } from '../files/mobile-file-media-handoff'
import { IMAGE_EXTENSIONS } from '../session/mobile-artifact-kind'
import { detectFilePathSegments } from './markdown-file-path-detection'

// A tap on an agent-written path only lands if something downstream can present
// it: the image viewer, the text/syntax viewer, or the OS handoff. Every
// extension those cover has to be detectable here too, or the agent's own
// "saved to /…/out.png" stays dead text on the phone.
//
// The text viewer has no extension list of its own — it renders whatever it is
// handed — so the build-log extensions agents actually emit are named here.
const TEXT_VIEWER_ARTIFACT_EXTENSIONS = ['log']

const PRESENTABLE_ARTIFACT_EXTENSIONS = [
  ...IMAGE_EXTENSIONS,
  ...Object.keys(MEDIA_HANDOFF_MIME_TYPES),
  ...TEXT_VIEWER_ARTIFACT_EXTENSIONS
].sort()

describe('agent artifact paths in prose', () => {
  it.each(PRESENTABLE_ARTIFACT_EXTENSIONS)(
    'makes an absolute /…/out.%s path tappable',
    (extension) => {
      const path = `/tmp/out.${extension}`
      expect(detectFilePathSegments(`wrote ${path} just now`)).toEqual([
        { type: 'text', value: 'wrote ' },
        { type: 'file', value: path, path },
        { type: 'text', value: ' just now' }
      ])
    }
  )
})
