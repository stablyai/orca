import { spawn } from 'child_process';
import { RELAY_SENTINEL, FrameDecoder, encodeJsonRpcFrame, parseJsonRpcMessage, MessageType } from './protocol';
export function spawnRelay(entryPath, args = []) {
    const proc = spawn('node', [entryPath, ...args], {
        stdio: ['pipe', 'pipe', 'pipe']
    });
    const responses = [];
    let nextSeq = 1;
    let sentinelResolved = false;
    let stdoutBuffer = Buffer.alloc(0);
    let sentinelResolve;
    let decoderActive = false;
    const sentinelReceived = new Promise((resolve) => {
        sentinelResolve = resolve;
    });
    const decoder = new FrameDecoder((frame) => {
        if (frame.type !== MessageType.Regular) {
            return;
        }
        try {
            const msg = parseJsonRpcMessage(frame.payload);
            responses.push(msg);
        }
        catch {
            /* skip malformed */
        }
    });
    proc.stdout.on('data', (chunk) => {
        if (!sentinelResolved) {
            stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
            const sentinelBuf = Buffer.from(RELAY_SENTINEL, 'utf-8');
            const idx = stdoutBuffer.indexOf(sentinelBuf);
            if (idx !== -1) {
                sentinelResolved = true;
                decoderActive = true;
                sentinelResolve();
                const remainder = stdoutBuffer.subarray(idx + sentinelBuf.length);
                if (remainder.length > 0) {
                    decoder.feed(remainder);
                }
            }
        }
        else if (decoderActive) {
            decoder.feed(chunk);
        }
    });
    proc.stderr.on('data', () => {
        /* drain */
    });
    const send = (method, params) => {
        const id = nextSeq++;
        const req = {
            jsonrpc: '2.0',
            id,
            method,
            ...(params !== undefined ? { params } : {})
        };
        proc.stdin.write(encodeJsonRpcFrame(req, id, 0));
        return id;
    };
    const sendNotification = (method, params) => {
        const seq = nextSeq++;
        const notif = {
            jsonrpc: '2.0',
            method,
            ...(params !== undefined ? { params } : {})
        };
        proc.stdin.write(encodeJsonRpcFrame(notif, seq, 0));
    };
    const waitForResponse = (id, timeoutMs = 5000) => {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                const found = responses.find((r) => 'id' in r && r.id === id);
                if (found) {
                    resolve(found);
                    return;
                }
                if (Date.now() > deadline) {
                    reject(new Error(`Timed out waiting for response id=${id}`));
                    return;
                }
                setTimeout(check, 10);
            };
            check();
        });
    };
    const waitForNotification = (method, timeoutMs = 5000) => {
        return new Promise((resolve, reject) => {
            const deadline = Date.now() + timeoutMs;
            const seen = responses.length;
            const check = () => {
                for (let i = seen; i < responses.length; i++) {
                    const r = responses[i];
                    if ('method' in r && r.method === method) {
                        resolve(r);
                        return;
                    }
                }
                if (Date.now() > deadline) {
                    reject(new Error(`Timed out waiting for notification "${method}"`));
                    return;
                }
                setTimeout(check, 10);
            };
            check();
        });
    };
    const kill = (signal = 'SIGTERM') => {
        proc.kill(signal);
    };
    const waitForExit = (timeoutMs = 5000) => {
        return new Promise((resolve, reject) => {
            if (proc.exitCode !== null) {
                resolve(proc.exitCode);
                return;
            }
            const timer = setTimeout(() => {
                reject(new Error('Timed out waiting for process exit'));
            }, timeoutMs);
            proc.once('exit', (code) => {
                clearTimeout(timer);
                resolve(code);
            });
        });
    };
    return {
        proc,
        responses,
        sentinelReceived,
        send,
        sendNotification,
        waitForResponse,
        waitForNotification,
        kill,
        waitForExit
    };
}
