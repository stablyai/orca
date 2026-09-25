export const DEFAULT_TOTAL_TIMEOUT_MS = 45 * 60_000;
export const DEFAULT_SILENCE_LIMIT_MS = 10 * 60_000;

export interface StallLimits {
  readonly totalTimeoutMs: number;
  readonly silenceLimitMs: number;
}

export interface StallInput {
  /** Toàn bộ là epoch ms, do caller đọc đồng hồ — hàm này không gọi Date.now() để test được. */
  readonly now: number;
  readonly startedAt: number;
  /** Lần cuối có tín hiệu sống: heartbeat, output, hoặc message `gate`. */
  readonly lastSignalAt: number;
}

export type StallVerdict =
  | { readonly stalled: false }
  | { readonly stalled: true; readonly reason: 'total-timeout' | 'silence' };

/**
 * Hai lưới an toàn độc lập với lời agent (blueprint §3.2a). Kết quả chỉ dẫn tới `status:blocked`,
 * KHÔNG được kill: theo hợp đồng orchestration, chỉ liveness `exited` mới là bằng chứng tiến trình
 * chết; `unverifiable` chỉ là vắng tin.
 */
export function checkStall(
  input: StallInput,
  limits: StallLimits = {
    totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
    silenceLimitMs: DEFAULT_SILENCE_LIMIT_MS
  }
): StallVerdict {
  if (input.now - input.startedAt >= limits.totalTimeoutMs) {
    return { stalled: true, reason: 'total-timeout' };
  }
  if (input.now - input.lastSignalAt >= limits.silenceLimitMs) {
    return { stalled: true, reason: 'silence' };
  }
  return { stalled: false };
}
