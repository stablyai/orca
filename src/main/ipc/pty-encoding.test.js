/**
 * Tests for Windows UTF-8 encoding fix.
 *
 * Unit tests demonstrate the GBK/UTF-8 encoding mismatch that causes garbled
 * CJK characters. Integration tests spawn real shell processes to verify the
 * code page and encoding are correctly set by our shell arguments.
 *
 * Why child_process instead of node-pty: node-pty's ConPTY backend requires
 * a real console handle (AttachConsole), which vitest workers don't have.
 * child_process.spawn is sufficient to verify the shell arguments produce
 * the correct encoding configuration.
 */
import { execSync } from 'child_process';
import { describe, expect, it } from 'vitest';
const isWindows = process.platform === 'win32';
describe('Windows PTY UTF-8 encoding', () => {
    // Why: GBK (code page 936) is the default console encoding on Chinese Windows.
    // When ConPTY uses GBK internally and node-pty decodes the pipe as UTF-8,
    // CJK characters are garbled. This test proves the root cause: GBK-encoded
    // bytes are invalid or produce wrong characters when decoded as UTF-8.
    describe('encoding mismatch (root cause)', () => {
        it('GBK-encoded CJK bytes produce garbled output when decoded as UTF-8', () => {
            // "你好" in GBK is [0xC4, 0xE3, 0xBA, 0xC3]
            const gbkBytes = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]);
            // Decoding GBK bytes as UTF-8 produces replacement characters
            const garbled = gbkBytes.toString('utf8');
            expect(garbled).not.toBe('你好');
            expect(garbled).toContain('\ufffd');
        });
        it('UTF-8 encoded CJK bytes decode correctly', () => {
            // "你好" in UTF-8 is [0xE4, 0xBD, 0xA0, 0xE5, 0xA5, 0xBD]
            const utf8Bytes = Buffer.from([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
            expect(utf8Bytes.toString('utf8')).toBe('你好');
        });
        it('multi-byte split across buffer boundaries produces replacement chars', () => {
            // Simulates ConPTY pipe read splitting a 3-byte UTF-8 char "你" across reads.
            // First read gets bytes [0xE4, 0xBD], second read gets [0xA0].
            // If each chunk is decoded independently (no StringDecoder), the result is garbled.
            const chunk1 = Buffer.from([0xe4, 0xbd]);
            const chunk2 = Buffer.from([0xa0]);
            const decoded1 = chunk1.toString('utf8'); // incomplete sequence → replacement char
            const decoded2 = chunk2.toString('utf8'); // orphan continuation byte → replacement char
            // Concatenating independently decoded chunks does NOT produce "你"
            expect(decoded1 + decoded2).not.toBe('你');
        });
        it('StringDecoder correctly handles split multi-byte sequences', () => {
            // This is what node-pty does internally — StringDecoder buffers incomplete
            // trailing bytes and prepends them to the next write.
            const { StringDecoder } = require('string_decoder');
            const decoder = new StringDecoder('utf8');
            const chunk1 = Buffer.from([0xe4, 0xbd]);
            const chunk2 = Buffer.from([0xa0]);
            const result = decoder.write(chunk1) + decoder.write(chunk2);
            expect(result).toBe('你');
        });
    });
    describe.skipIf(!isWindows)('real shell encoding verification', () => {
        it('cmd.exe /K chcp 65001 sets code page to UTF-8', () => {
            // Spawn cmd.exe with the same args our fix uses, then query the code page.
            const output = execSync('cmd.exe /C "chcp 65001 > nul && chcp"', {
                encoding: 'utf-8',
                timeout: 10_000
            });
            expect(output).toContain('65001');
        });
        it('cmd.exe echoes CJK characters correctly with code page 65001', () => {
            const output = execSync('cmd.exe /C "chcp 65001 > nul && echo 你好世界"', {
                encoding: 'utf-8',
                timeout: 10_000
            });
            expect(output).toContain('你好世界');
        });
        it('powershell.exe outputs UTF-8 after setting Console encoding', () => {
            const output = execSync('powershell.exe -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding.BodyName"', {
                encoding: 'utf-8',
                timeout: 15_000
            });
            expect(output.trim()).toBe('utf-8');
        });
        it('powershell.exe outputs CJK characters correctly with UTF-8 encoding', () => {
            const output = execSync('powershell.exe -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output \'你好世界\'"', {
                encoding: 'utf-8',
                timeout: 15_000
            });
            expect(output.trim()).toBe('你好世界');
        });
        it('try/catch in profile loading does not prevent encoding from being set', () => {
            // Simulates a broken $PROFILE that throws a terminating error.
            // Our fix wraps it in try/catch so encoding is still set afterward.
            const output = execSync('powershell.exe -NoProfile -Command "try { throw \'profile broken\' } catch {}; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding.BodyName"', {
                encoding: 'utf-8',
                timeout: 15_000
            });
            expect(output.trim()).toBe('utf-8');
        });
        it('without try/catch, a terminating error prevents encoding from being set', () => {
            // Proves that WITHOUT the try/catch fix, a broken profile would prevent
            // the encoding commands from executing. This is the bug the second review caught.
            try {
                execSync('powershell.exe -NoProfile -Command "throw \'profile broken\'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::OutputEncoding.BodyName"', {
                    encoding: 'utf-8',
                    timeout: 15_000
                });
                // If we get here, the throw didn't halt execution (shouldn't happen)
                expect.unreachable('throw should have caused a non-zero exit code');
            }
            catch (err) {
                // The command fails because the throw halts execution before
                // the encoding line runs — proving why try/catch is necessary.
                const error = err;
                expect(error.status).not.toBe(0);
            }
        });
    });
});
