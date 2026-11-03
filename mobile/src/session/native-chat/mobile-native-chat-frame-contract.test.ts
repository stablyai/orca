import { describe, expectTypeOf, it } from 'vitest'
import type { NativeChatTranscriptFrame } from '../../../../src/shared/native-chat/native-chat-transcript-frames'
import type { MobileNativeChatStreamFrame } from './mobile-native-chat-stream-frame'

describe('the phone native-chat frame against the desktop contract', () => {
  it('reads every frame the desktop streams', () => {
    expectTypeOf<NativeChatTranscriptFrame>().toExtend<MobileNativeChatStreamFrame>()
  })
})
