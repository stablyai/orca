export { FrameType } from './types';
import type { FrameType } from './types';
import { FRAME_HEADER_SIZE } from './types';
export { FRAME_HEADER_SIZE };
export declare function encodeFrame(type: FrameType, payload: Buffer): Buffer;
export type FrameParser = {
    feed(chunk: Buffer): void;
    reset(): void;
};
export declare function createFrameParser(onFrame: (type: FrameType, payload: Buffer) => void): FrameParser;
