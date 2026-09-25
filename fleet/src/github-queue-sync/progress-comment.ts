import type { GateReport } from '../iteration-guard/gate-report.ts';
import { dedupeReports } from '../iteration-guard/iteration-guard.ts';
import type { GithubPort, IssueComment } from './github-port.ts';
import { renderStateMarker } from './state-marker.ts';

export const PROGRESS_MARKER = '<!-- orca-fleet:progress -->';
const TIMESTAMP_LINE = /^_Cập nhật: .*_$/m;
const VIETNAM_OFFSET_MS = 7 * 60 * 60_000;

export interface ProgressRow {
  readonly iteration: number;
  readonly result: 'green' | 'red';
  readonly note: string;
}

export interface ProgressState {
  readonly worktree: string;
  readonly agent: string;
  readonly dispatchId: string;
  readonly rows: readonly ProgressRow[];
  readonly updatedAt: Date;
}

/** Số vòng tính theo thứ tự báo cáo thực nhận (đã khử trùng), không theo số agent tự khai. */
export function progressRowsFromReports(reports: readonly GateReport[]): ProgressRow[] {
  return dedupeReports(reports).map((report, index) => ({
    iteration: index + 1,
    result: report.result,
    note: report.failing ?? ''
  }));
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replaceAll('|', '\\|').trim();
}

function formatVietnamTime(date: Date): string {
  return new Date(date.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

/** Một comment duy nhất mỗi issue: bảng vòng lặp + marker trạng thái để khôi phục sau restart. */
export function renderProgressComment(state: ProgressState): string {
  const rows = state.rows.map(
    (row) => `| ${row.iteration} | ${row.result === 'green' ? '🟢' : '🔴'} | ${escapeCell(row.note)} |`
  );
  return [
    PROGRESS_MARKER,
    renderStateMarker({ dispatch: state.dispatchId, iteration: state.rows.length, worktree: state.worktree }),
    `### 🤖 Tiến độ Fleet — \`${state.worktree}\` (agent: ${state.agent})`,
    '| Vòng | Cổng kiểm tra | Ghi chú |',
    '|---|---|---|',
    ...rows,
    `_Cập nhật: ${formatVietnamTime(state.updatedAt)} (UTC+7)_`
  ].join('\n');
}

function withoutTimestamp(body: string): string {
  return body.replace(TIMESTAMP_LINE, '').trim();
}

export function findProgressComment(comments: readonly IssueComment[]): IssueComment | undefined {
  return comments.find((comment) => comment.body.includes(PROGRESS_MARKER));
}

/**
 * Tạo hoặc SỬA TẠI CHỖ comment tiến độ (blueprint §3.3) — không đăng comment mới mỗi vòng.
 * Nội dung chỉ khác dòng "Cập nhật" thì bỏ qua, không tốn một lượt gọi API.
 */
export async function upsertProgressComment(
  github: GithubPort,
  issueNumber: number,
  state: ProgressState,
  existingComments?: readonly IssueComment[]
): Promise<'created' | 'updated' | 'unchanged'> {
  const comments = existingComments ?? (await github.readIssue(issueNumber)).comments;
  const body = renderProgressComment(state);
  const existing = findProgressComment(comments);
  if (existing === undefined) {
    await github.addComment(issueNumber, body);
    return 'created';
  }
  if (withoutTimestamp(existing.body) === withoutTimestamp(body)) {
    return 'unchanged';
  }
  await github.updateComment(existing.id, body);
  return 'updated';
}
