import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readRuntimeMetadata, type RuntimeMetadata } from './runtime-metadata.ts';

export interface RpcError {
  code: string;
  message: string;
  data?: unknown;
}

export interface RpcResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: RpcError;
  _meta?: {
    runtimeId?: string;
  };
}

/**
 * Gửi lệnh JSON-RPC tới Orca Runtime qua Windows Named Pipe hoặc Unix Socket.
 * Tự động đọc auth token và socket endpoint từ orca-runtime.json.
 */
export async function callOrca<TResult = unknown>(
  method: string,
  params: unknown = {},
  timeoutMs: number = 60_000
): Promise<TResult> {
  const metadata = readRuntimeMetadata();
  const transport = metadata.transports.find((t) => t.kind === 'named-pipe' || t.kind === 'unix');

  if (!transport || !metadata.authToken) {
    throw new Error('Orca runtime chưa sẵn sàng: Không tìm thấy transport Named Pipe hoặc AuthToken.');
  }

  const requestId = randomUUID();
  const payload = JSON.stringify({
    id: requestId,
    authToken: metadata.authToken,
    method,
    params,
  }) + '\n';

  return new Promise<TResult>((resolve, reject) => {
    let socket: Socket | null = null;
    let buffer = '';
    let settled = false;

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (socket) {
        socket.destroy();
      }
      reject(new Error(`[Orca RPC] Timeout sau ${timeoutMs}ms khi gọi phương thức '${method}'.`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (socket) {
        socket.removeAllListeners();
        socket.end();
      }
    };

    try {
      socket = createConnection(transport.endpoint);
    } catch (err) {
      clearTimeout(timeoutTimer);
      reject(err);
      return;
    }

    socket.setEncoding('utf8');

    socket.on('connect', () => {
      socket?.write(payload);
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIdx: number;

      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          settled = true;
          cleanup();
          reject(new Error(`[Orca RPC] Frame phản hồi không hợp lệ: ${line}`));
          return;
        }

        // Nếu là keepalive frame của long-poll, gia hạn timer
        if (frame._keepalive) {
          timeoutTimer.refresh();
          continue;
        }

        // Nhận kết quả cuối cùng
        settled = true;
        cleanup();

        if (frame.id !== requestId) {
          reject(new Error(`[Orca RPC] Mismatched request ID: mong đợi ${requestId}, nhận ${frame.id}`));
          return;
        }

        if (frame.ok) {
          resolve(frame.result as TResult);
        } else {
          const err = new Error(frame.error?.message || `Lỗi Orca RPC (${frame.error?.code || 'unknown'})`);
          (err as any).code = frame.error?.code;
          (err as any).data = frame.error?.data;
          reject(err);
        }
        return;
      }
    });

    socket.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`[Orca RPC] Lỗi kết nối socket: ${err.message}. Có thể Orca Desktop chưa bật.`));
    });

    socket.on('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('[Orca RPC] Kết nối bị đóng trước khi Orca phản hồi.'));
    });
  });
}
