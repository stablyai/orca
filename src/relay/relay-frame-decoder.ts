import { FrameDecoder as SharedFrameDecoder } from '../shared/relay-frame-decoder'
import type { DecodedFrame, FrameDecoderOptions } from '../shared/relay-frame-decoder-contract'

export {
  HEADER_LENGTH,
  MAX_MESSAGE_SIZE,
  FRAME_DECODER_MAX_FRAMES_PER_TURN,
  FRAME_DECODER_MAX_BYTES_PER_TURN,
  FRAME_DECODER_MAX_TURN_MS,
  FRAME_DECODER_MAX_RETAINED_BYTES
} from '../shared/relay-frame-decoder'
export {
  FrameDecoderContinuationError,
  type DecodedFrame,
  type FrameDecoderOptions
} from '../shared/relay-frame-decoder-contract'

// Why: the relay runs standalone on remote hosts with no renderer to surface
// decode faults, so an omitted handler must still reach stderr.
export class FrameDecoder extends SharedFrameDecoder {
  constructor(
    onFrame: (frame: DecodedFrame) => void,
    onError?: (err: Error) => void,
    options: FrameDecoderOptions = {}
  ) {
    super(
      onFrame,
      onError ?? ((error) => process.stderr.write(`[relay] ${error.message}\n`)),
      options
    )
  }
}
