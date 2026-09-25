import type { GithubPort } from './github-port.ts';
import { parseAgentTaskForm } from './issue-form-parser.ts';
import type { ActiveTask } from '../file-overlap-guard/dispatch-selection.ts';

const ACTIVE_LIMIT = 50;

/**
 * Trích xuất trạng thái queue từ danh sách nhãn.
 * Ví dụ: ['size:S', 'status:in-progress'] -> 'in-progress'.
 */
function extractStatus(labels: readonly string[]): string | undefined {
  for (const label of labels) {
    if (label.startsWith('status:')) {
      return label.slice('status:'.length);
    }
  }
  return undefined;
}

/**
 * Tải danh sách các task đang active và giữ khoá phạm vi file.
 *
 * Với mỗi issue đang active có trạng thái thuộc `holdingStatuses`:
 * 1. Gọi `github.readIssue` để lấy nội dung form.
 * 2. Gọi `parseAgentTaskForm` để phân tích phạm vi file (`fileScope`).
 * 3. Nếu parse thành công: ghi nhận scope tương ứng.
 * 4. Nếu KHÔNG parse được (lỗi form, placeholder, body hỏng):
 *    Gán `scope: ['**']` (nguyên tắc fail-closed: chưa rõ phạm vi thì coi như xung đột với mọi file)
 *    và ghi log cảnh báo.
 */
export async function loadHolders(
  github: GithubPort,
  holdingStatuses: readonly string[] = ['claimed', 'in-progress'],
  log?: (msg: string) => void,
): Promise<ActiveTask[]> {
  const activeIssues = await github.listActiveIssues(ACTIVE_LIMIT);
  const holdingSet = new Set(holdingStatuses);
  const holders: ActiveTask[] = [];

  for (const summary of activeIssues) {
    const status = extractStatus(summary.labels);
    if (status === undefined || !holdingSet.has(status)) {
      continue;
    }

    try {
      const { issue } = await github.readIssue(summary.number);
      const parsed = parseAgentTaskForm(issue.body);
      if (parsed.ok) {
        holders.push({
          issueNumber: summary.number,
          scope: parsed.form.scopePatterns,
          status,
        });
      } else {
        log?.(
          `[active-scope-holders] Issue #${summary.number} không parse được form (${parsed.problems.map((p) => p.code).join(', ')}), gán scope ['**'] (fail-closed)`,
        );
        holders.push({
          issueNumber: summary.number,
          scope: ['**'],
          status,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log?.(
        `[active-scope-holders] Không đọc được issue #${summary.number}: ${message}, gán scope ['**'] (fail-closed)`,
      );
      holders.push({
        issueNumber: summary.number,
        scope: ['**'],
        status,
      });
    }
  }

  return holders;
}
