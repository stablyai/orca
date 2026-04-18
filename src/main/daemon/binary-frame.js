export { FrameType } from './types';
import { FRAME_HEADER_SIZE, FRAME_MAX_PAYLOAD } from './types';
export { FRAME_HEADER_SIZE };
export function encodeFrame(type, payload) {
    if (payload.length > FRAME_MAX_PAYLOAD) {
        throw new Error(`Frame payload ${payload.length} exceeds max ${FRAME_MAX_PAYLOAD}`);
    }
    const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.length);
    frame[0] = type;
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, FRAME_HEADER_SIZE);
    return frame;
}
export function createFrameParser(onFrame) {
    let buffer = Buffer.alloc(0);
    function parse() {
        while (buffer.length >= FRAME_HEADER_SIZE) {
            const payloadLength = buffer.readUInt32BE(1);
            const totalLength = FRAME_HEADER_SIZE + payloadLength;
            if (buffer.length < totalLength) {
                break;
            }
            const type = buffer[0];
            const payload = buffer.subarray(FRAME_HEADER_SIZE, totalLength);
            buffer = buffer.subarray(totalLength);
            onFrame(type, payload);
        }
    }
    return {
        feed(chunk) {
            buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
            parse();
        },
        reset() {
            buffer = Buffer.alloc(0);
        }
    };
}
