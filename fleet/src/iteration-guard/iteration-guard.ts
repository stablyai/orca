import type { GateReport } from './gate-report.ts';

export const MAX_ITERATIONS = 5;

/**
 * - `continue`: cho worker chạy tiếp.
 * - `open-pr`: cổng xanh trong ngân sách vòng. Fleet vẫn phải tự chạy lại cổng để xác minh
 *   trước khi gắn `status:review` (blueprint §6: agent có thể khai "pass" khi chưa chạy).
 * - `block`: hết ngân sách vòng → `status:blocked`.
 */
export type GuardAction = 'continue' | 'open-pr' | 'block';

/**
 * Bỏ báo cáo trùng `messageId`, giữ bản đến trước. Bắt buộc vì `check` replay cả batch cho tới
 * khi ack — không khử trùng thì một lần đỏ bị đếm hai lần và task bị chặn oan.
 */
export function dedupeReports(history: readonly GateReport[]): GateReport[] {
  const seen = new Set<string>();
  const unique: GateReport[] = [];
  for (const report of history) {
    if (!seen.has(report.messageId)) {
      seen.add(report.messageId);
      unique.push(report);
    }
  }
  return unique;
}

/**
 * Đếm theo số báo cáo thực nhận, không tin `claimedIteration` agent tự khai.
 *
 * Báo cáo xanh chỉ được chấp nhận khi nằm trong ngân sách (≤ maxIterations lần chạy cổng).
 * Xanh ở lần thứ 6 trở đi nghĩa là agent đã chạy quá giới hạn mà Fleet chưa kịp chặn → vẫn `block`.
 */
export function nextAction(history: readonly GateReport[], maxIterations: number = MAX_ITERATIONS): GuardAction {
  const reports = dedupeReports(history);
  if (reports.length > maxIterations) {
    return 'block';
  }
  if (reports.at(-1)?.result === 'green') {
    return 'open-pr';
  }
  return reports.length >= maxIterations ? 'block' : 'continue';
}
