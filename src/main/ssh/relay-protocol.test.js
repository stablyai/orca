import { describe, expect, it } from 'vitest';
import { HEADER_LENGTH, MessageType, encodeFrame, encodeJsonRpcFrame, encodeKeepAliveFrame, FrameDecoder, parseJsonRpcMessage, parseUnameToRelayPlatform } from './relay-protocol';
describe('frame encoding', () => {
    it('encodes a frame with 13-byte header', () => {
        const payload = Buffer.from('hello');
        const frame = encodeFrame(MessageType.Regular, 1, 0, payload);
        expect(frame.length).toBe(HEADER_LENGTH + payload.length);
        expect(frame[0]).toBe(MessageType.Regular);
        expect(frame.readUInt32BE(1)).toBe(1); // ID
        expect(frame.readUInt32BE(5)).toBe(0); // ACK
        expect(frame.readUInt32BE(9)).toBe(5); // LENGTH
        expect(frame.subarray(HEADER_LENGTH).toString()).toBe('hello');
    });
    it('encodes keepalive frame with empty payload', () => {
        const frame = encodeKeepAliveFrame(42, 10);
        expect(frame.length).toBe(HEADER_LENGTH);
        expect(frame[0]).toBe(MessageType.KeepAlive);
        expect(frame.readUInt32BE(1)).toBe(42); // ID
        expect(frame.readUInt32BE(5)).toBe(10); // ACK
        expect(frame.readUInt32BE(9)).toBe(0); // LENGTH
    });
    it('encodes JSON-RPC frame', () => {
        const msg = {
            jsonrpc: '2.0',
            id: 1,
            method: 'pty.spawn',
            params: { cols: 80, rows: 24 }
        };
        const frame = encodeJsonRpcFrame(msg, 5, 3);
        expect(frame[0]).toBe(MessageType.Regular);
        expect(frame.readUInt32BE(1)).toBe(5);
        expect(frame.readUInt32BE(5)).toBe(3);
        const payloadLen = frame.readUInt32BE(9);
        const payload = frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLen);
        const decoded = JSON.parse(payload.toString('utf-8'));
        expect(decoded.method).toBe('pty.spawn');
        expect(decoded.params.cols).toBe(80);
    });
    it('rejects messages larger than MAX_MESSAGE_SIZE', () => {
        const bigPayload = {
            jsonrpc: '2.0',
            id: 1,
            method: 'x',
            params: { data: 'a'.repeat(17 * 1024 * 1024) }
        };
        expect(() => encodeJsonRpcFrame(bigPayload, 1, 0)).toThrow('Message too large');
    });
});
describe('FrameDecoder', () => {
    it('decodes a complete frame', () => {
        const frames = [];
        const decoder = new FrameDecoder((f) => frames.push(f));
        const payload = Buffer.from('test');
        const encoded = encodeFrame(MessageType.Regular, 1, 0, payload);
        decoder.feed(encoded);
        expect(frames).toHaveLength(1);
        expect(frames[0].type).toBe(MessageType.Regular);
        expect(frames[0].id).toBe(1);
        expect(frames[0].ack).toBe(0);
        expect(frames[0].payload.toString()).toBe('test');
    });
    it('handles partial frames across multiple feeds', () => {
        const frames = [];
        const decoder = new FrameDecoder((f) => frames.push(f));
        const payload = Buffer.from('hello world');
        const encoded = encodeFrame(MessageType.Regular, 2, 1, payload);
        // Feed in two parts
        decoder.feed(encoded.subarray(0, 10));
        expect(frames).toHaveLength(0);
        decoder.feed(encoded.subarray(10));
        expect(frames).toHaveLength(1);
        expect(frames[0].payload.toString()).toBe('hello world');
    });
    it('decodes multiple frames from a single chunk', () => {
        const frames = [];
        const decoder = new FrameDecoder((f) => frames.push(f));
        const frame1 = encodeFrame(MessageType.Regular, 1, 0, Buffer.from('a'));
        const frame2 = encodeFrame(MessageType.Regular, 2, 1, Buffer.from('b'));
        const combined = Buffer.concat([frame1, frame2]);
        decoder.feed(combined);
        expect(frames).toHaveLength(2);
        expect(frames[0].payload.toString()).toBe('a');
        expect(frames[1].payload.toString()).toBe('b');
    });
    it('decodes keepalive frames', () => {
        const frames = [];
        const decoder = new FrameDecoder((f) => frames.push(f));
        decoder.feed(encodeKeepAliveFrame(5, 3));
        expect(frames).toHaveLength(1);
        expect(frames[0].type).toBe(MessageType.KeepAlive);
        expect(frames[0].payload.length).toBe(0);
    });
    it('skips oversized frames and calls onError instead of throwing', () => {
        const errors = [];
        const frames = [];
        const decoder = new FrameDecoder((f) => frames.push(f), (err) => errors.push(err));
        const oversizedLength = 17 * 1024 * 1024;
        const header = Buffer.alloc(HEADER_LENGTH);
        header[0] = MessageType.Regular;
        header.writeUInt32BE(1, 1);
        header.writeUInt32BE(0, 5);
        header.writeUInt32BE(oversizedLength, 9);
        const fakePayload = Buffer.alloc(oversizedLength);
        const fullFrame = Buffer.concat([header, fakePayload]);
        decoder.feed(fullFrame);
        expect(frames).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('discarded');
    });
    it('reset clears internal buffer', () => {
        const frames = [];
        const decoder = new FrameDecoder((f) => frames.push(f));
        // Feed a partial frame
        const encoded = encodeFrame(MessageType.Regular, 1, 0, Buffer.from('test'));
        decoder.feed(encoded.subarray(0, 5));
        decoder.reset();
        // Feed a new complete frame
        decoder.feed(encodeFrame(MessageType.Regular, 2, 0, Buffer.from('new')));
        expect(frames).toHaveLength(1);
        expect(frames[0].id).toBe(2);
    });
});
describe('parseJsonRpcMessage', () => {
    it('parses a valid JSON-RPC request', () => {
        const payload = Buffer.from(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'pty.spawn',
            params: { cols: 80 }
        }));
        const msg = parseJsonRpcMessage(payload);
        expect('method' in msg && msg.method).toBe('pty.spawn');
    });
    it('throws on invalid jsonrpc version', () => {
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'x' }));
        expect(() => parseJsonRpcMessage(payload)).toThrow('Invalid JSON-RPC version');
    });
    it('throws on malformed JSON', () => {
        const payload = Buffer.from('not json');
        expect(() => parseJsonRpcMessage(payload)).toThrow();
    });
});
describe('parseUnameToRelayPlatform', () => {
    it('maps Linux x86_64', () => {
        expect(parseUnameToRelayPlatform('Linux', 'x86_64')).toBe('linux-x64');
    });
    it('maps Linux aarch64', () => {
        expect(parseUnameToRelayPlatform('Linux', 'aarch64')).toBe('linux-arm64');
    });
    it('maps Darwin x86_64', () => {
        expect(parseUnameToRelayPlatform('Darwin', 'x86_64')).toBe('darwin-x64');
    });
    it('maps Darwin arm64', () => {
        expect(parseUnameToRelayPlatform('Darwin', 'arm64')).toBe('darwin-arm64');
    });
    it('handles amd64 alias', () => {
        expect(parseUnameToRelayPlatform('Linux', 'amd64')).toBe('linux-x64');
    });
    it('returns null for unsupported OS', () => {
        expect(parseUnameToRelayPlatform('FreeBSD', 'x86_64')).toBeNull();
    });
    it('returns null for unsupported arch', () => {
        expect(parseUnameToRelayPlatform('Linux', 'mips')).toBeNull();
    });
    it('is case-insensitive', () => {
        expect(parseUnameToRelayPlatform('LINUX', 'X86_64')).toBe('linux-x64');
    });
});
