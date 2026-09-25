export type GateResult = 'green' | 'red';

/**
 * Một lần worker báo kết quả cổng kiểm tra (message `gate`, xem blueprint §3.2a).
 * `messageId` dùng để khử trùng: `orca orchestration check` replay cả batch cho tới khi ack.
 */
export interface GateReport {
  readonly messageId: string;
  readonly result: GateResult;
  /** Số vòng do agent tự khai — chỉ để hiển thị, KHÔNG dùng để đếm (agent có thể khai sai). */
  readonly claimedIteration?: number;
  readonly failing?: string;
}

export interface OrchestrationMessageLike {
  readonly id: string;
  readonly payload?: string | Record<string, unknown> | null;
}

export type GateParseOutcome =
  | { readonly kind: 'gate'; readonly report: GateReport }
  | { readonly kind: 'ignored'; readonly reason: GateIgnoreReason };

export type GateIgnoreReason = 'no-payload' | 'invalid-json' | 'not-a-gate-message' | 'invalid-result';

function readPayload(raw: OrchestrationMessageLike['payload']): Record<string, unknown> | GateIgnoreReason {
  if (raw === undefined || raw === null || raw === '') {
    return 'no-payload';
  }
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'invalid-json';
  } catch {
    return 'invalid-json';
  }
}

/**
 * Chỉ nhận message có `fleet: "gate"`. Message khác (worker_done, heartbeat, hỏi đáp)
 * đi qua cùng kênh nên phải bỏ qua có lý do, không được ném lỗi làm sập vòng đọc.
 */
export function parseGateMessage(message: OrchestrationMessageLike): GateParseOutcome {
  const payload = readPayload(message.payload);
  if (typeof payload === 'string') {
    return { kind: 'ignored', reason: payload };
  }
  if (payload.fleet !== 'gate') {
    return { kind: 'ignored', reason: 'not-a-gate-message' };
  }
  if (payload.result !== 'green' && payload.result !== 'red') {
    return { kind: 'ignored', reason: 'invalid-result' };
  }
  const claimed = payload.iteration;
  const failing = payload.failing;
  return {
    kind: 'gate',
    report: {
      messageId: message.id,
      result: payload.result,
      ...(typeof claimed === 'number' && Number.isInteger(claimed) ? { claimedIteration: claimed } : {}),
      ...(typeof failing === 'string' ? { failing } : {})
    }
  };
}
