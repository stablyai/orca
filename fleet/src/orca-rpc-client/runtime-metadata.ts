import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Transport {
  kind: 'unix' | 'named-pipe' | 'websocket';
  endpoint: string;
}

export interface RuntimeMetadata {
  runtimeId?: string;
  pid: number;
  authToken: string | null;
  transports: Transport[];
  startedAt?: number;
}

/**
 * Đọc runtime metadata của Orca từ orca-runtime.json.
 * Mặc định nằm tại %APPDATA%\orca\orca-runtime.json trên Windows.
 */
export function readRuntimeMetadata(): RuntimeMetadata {
  const base = process.env.ORCA_USER_DATA_PATH ?? join(process.env.APPDATA ?? '', 'orca');
  const metadataPath = join(base, 'orca-runtime.json');

  if (!existsSync(metadataPath)) {
    throw new Error(`Không tìm thấy file metadata Orca tại: ${metadataPath}. Hãy đảm bảo ứng dụng Orca Desktop đang chạy.`);
  }

  try {
    const raw = readFileSync(metadataPath, 'utf8');
    return JSON.parse(raw) as RuntimeMetadata;
  } catch (err) {
    throw new Error(`Lỗi khi đọc file runtime metadata Orca (${metadataPath}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
