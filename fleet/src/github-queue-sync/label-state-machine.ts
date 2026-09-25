/**
 * Máy trạng thái của một task theo label `status:*` (blueprint §2.2).
 * `done` không có label: PR merged thì issue đóng (`Closes #n`), Fleet chỉ gỡ `status:review`.
 */
export type QueueStatus = 'triage' | 'ready' | 'claimed' | 'in-progress' | 'review' | 'blocked' | 'done';

export const STATUS_LABEL_PREFIX = 'status:';

const LABELED_STATUSES = ['triage', 'ready', 'claimed', 'in-progress', 'review', 'blocked'] as const;
type LabeledStatus = (typeof LABELED_STATUSES)[number];

/**
 * Cạnh hợp lệ. Ngoài §2.2 có hai bổ sung có chủ đích:
 * - `ready → triage`: issue thiếu spec bị Fleet trả về (blueprint §4.2).
 * - `claimed → blocked`: khởi chạy lỗi nhiều lần thì chặn, không trả về `ready` mãi (tránh vòng
 *   spawn vô hạn tốn tiền agent).
 * Con người đổi `triage → ready` và `blocked → ready`; Fleet đổi các cạnh còn lại.
 */
const TRANSITIONS: Readonly<Record<QueueStatus, readonly QueueStatus[]>> = {
  triage: ['ready'],
  ready: ['claimed', 'triage'],
  claimed: ['in-progress', 'ready', 'blocked'],
  'in-progress': ['review', 'blocked'],
  review: ['in-progress', 'done'],
  blocked: ['ready'],
  done: []
};

export function statusLabel(status: LabeledStatus): string {
  return `${STATUS_LABEL_PREFIX}${status}`;
}

function isLabeledStatus(value: string): value is LabeledStatus {
  return (LABELED_STATUSES as readonly string[]).includes(value);
}

export type StatusReading =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly status: LabeledStatus }
  /** Vi phạm bất biến "chỉ một label status:* tại một thời điểm" — cần người xem, không tự đoán. */
  | { readonly kind: 'conflict'; readonly statuses: readonly LabeledStatus[] };

export function readStatus(labels: readonly string[]): StatusReading {
  const statuses = [
    ...new Set(
      labels
        .filter((label) => label.startsWith(STATUS_LABEL_PREFIX))
        .map((label) => label.slice(STATUS_LABEL_PREFIX.length))
        .filter(isLabeledStatus)
    )
  ];
  const [first] = statuses;
  if (first === undefined) {
    return { kind: 'none' };
  }
  return statuses.length === 1 ? { kind: 'one', status: first } : { kind: 'conflict', statuses };
}

export function canTransition(from: QueueStatus, to: QueueStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export type TransitionPlan =
  | { readonly ok: true; readonly addLabels: readonly string[]; readonly removeLabels: readonly string[] }
  | { readonly ok: false; readonly reason: 'no-status' | 'conflicting-status' | 'illegal-transition' };

/**
 * Tính thay đổi nhãn để đi tới `to`. Thêm và gỡ đi cùng một lệnh (`gh issue edit`) nên không có
 * khoảnh khắc nào issue mang hai nhãn status. Đã ở đúng trạng thái đích → kế hoạch rỗng (idempotent,
 * không tốn một lượt gọi API).
 */
export function planTransition(labels: readonly string[], to: QueueStatus): TransitionPlan {
  const current = readStatus(labels);
  if (current.kind === 'none') {
    return { ok: false, reason: 'no-status' };
  }
  if (current.kind === 'conflict') {
    return { ok: false, reason: 'conflicting-status' };
  }
  if (current.status === to) {
    return { ok: true, addLabels: [], removeLabels: [] };
  }
  if (!canTransition(current.status, to)) {
    return { ok: false, reason: 'illegal-transition' };
  }
  return {
    ok: true,
    addLabels: to === 'done' ? [] : [statusLabel(to)],
    removeLabels: [statusLabel(current.status)]
  };
}
