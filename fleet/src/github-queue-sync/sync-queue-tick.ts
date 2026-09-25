import { assessIssue, formatTriageComment } from './dispatch-eligibility.ts';
import type { AgentTaskForm } from './issue-form-parser.ts';
import type { GithubPort } from './github-port.ts';
import { tryClaim } from './issue-claim.ts';
import type { QueueStatus } from './label-state-machine.ts';
import { planTransition } from './label-state-machine.ts';
import { upsertProgressComment } from './progress-comment.ts';
import type { DeferReason, ResourceVerdict } from '../resource-guard/resource-guard.ts';
import { formatDeferReason } from '../resource-guard/resource-guard.ts';
import { selectDispatchable, type ActiveTask } from '../file-overlap-guard/dispatch-selection.ts';
import { loadHolders } from './active-scope-holders.ts';

/** Số lần khởi chạy lỗi tối đa trước khi chặn task, thay vì trả về `ready` để bốc lại mãi. */
export const MAX_SPAWN_FAILURES = 3;
export const SPAWN_FAILURE_MARKER = '<!-- orca-fleet:spawn-failure -->';
const DEFAULT_ISSUES_PER_TICK = 3;
const READY_LIST_LIMIT = 50;

export interface DispatchRequest {
  readonly issueNumber: number;
  readonly title: string;
  readonly agent: string;
  readonly form: AgentTaskForm;
}

/** Bản thật gọi `orchestration.workerStart` của Orca; tiêm vào để test không cần Orca chạy. */
export type DispatchWorker = (request: DispatchRequest) => Promise<{ readonly dispatchId: string; readonly worktree: string }>;

export interface QueueSyncDeps {
  readonly github: GithubPort;
  /** Định danh tiến trình Fleet này, dùng trong marker claim. */
  readonly runId: string;
  readonly dispatchWorker: DispatchWorker;
  readonly maxIssuesPerTick?: number;
  readonly now?: () => Date;
  readonly resourceCheck?: () => ResourceVerdict;
  readonly holdingStatuses?: readonly string[];
  readonly log?: (msg: string) => void;
}

export interface TickReport {
  readonly returnedToTriage: number[];
  readonly dispatched: number[];
  readonly skipped: { readonly issue: number; readonly reason: string; readonly blockedBy?: readonly number[] }[];
  readonly failed: { readonly issue: number; readonly error: string }[];
  readonly deferredByResources?: readonly DeferReason[];
}

async function moveTo(github: GithubPort, issueNumber: number, labels: readonly string[], to: QueueStatus): Promise<void> {
  const plan = planTransition(labels, to);
  if (!plan.ok) {
    throw new Error(`Không thể chuyển #${issueNumber} sang ${to}: ${plan.reason}`);
  }
  if (plan.addLabels.length > 0 || plan.removeLabels.length > 0) {
    await github.changeLabels(issueNumber, { add: plan.addLabels, remove: plan.removeLabels });
  }
}

/**
 * Một vòng poll: đọc issue `status:ready`, trả về triage nếu thiếu spec, giành quyền và giao cho
 * worker nếu đủ. Lỗi ở một issue không dừng các issue khác. Giới hạn đồng thời theo agent/repo
 * (Phase 3.1) chưa có — chỉ có trần số issue mỗi vòng.
 */
export async function syncQueueTick(deps: QueueSyncDeps): Promise<TickReport> {
  const { github, runId } = deps;

  // Thứ tự chi phí: kiểm tài nguyên trước mọi lệnh GitHub.
  if (deps.resourceCheck !== undefined) {
    const verdict = deps.resourceCheck();
    if (!verdict.dispatch) {
      for (const reason of verdict.reasons) {
        deps.log?.(formatDeferReason(reason));
      }
      return {
        returnedToTriage: [],
        dispatched: [],
        skipped: [],
        failed: [],
        deferredByResources: verdict.reasons,
      };
    }
  }

  const report: TickReport = { returnedToTriage: [], dispatched: [], skipped: [], failed: [] };
  const limit = deps.maxIssuesPerTick ?? DEFAULT_ISSUES_PER_TICK;
  const now = deps.now ?? (() => new Date());

  const holdingStatuses = deps.holdingStatuses ?? ['claimed', 'in-progress'];
  let cachedHolders: ActiveTask[] | undefined;

  // Hạn chế: Khoá chồng phạm vi chỉ đúng khi một Fleet mỗi repo. Nếu hai Fleet cùng tải
  // danh sách active trước khi bên kia đổi nhãn claimed, cả hai có thể dispatch hai issue
  // trùng phạm vi trong cửa sổ tranh chấp đó. tryClaim chỉ chống trùng cùng một issue, không
  // chống trùng phạm vi giữa hai issue khác nhau. Ở lần poll tiếp theo hai task này sẽ thấy nhau,
  // nhưng lúc đó đã dispatch rồi. Chấp nhận được ở giai đoạn này (chưa phải khoá nguyên tử phân tán).
  async function getHolders(): Promise<ActiveTask[]> {
    if (cachedHolders === undefined) {
      cachedHolders = await loadHolders(github, holdingStatuses, deps.log);
    }
    return cachedHolders;
  }

  async function handleIssue(issueNumber: number): Promise<void> {
    const { issue, comments } = await github.readIssue(issueNumber);
    const verdict = assessIssue(issue);
    if (!verdict.eligible) {
      // Không còn `ready` = Fleet khác vừa giành hoặc người vừa đổi nhãn: không phải lỗi spec, đừng đụng.
      if (verdict.reasons.some((reason) => reason.code === 'not-ready')) {
        report.skipped.push({ issue: issueNumber, reason: 'no-longer-ready' });
        return;
      }
      await moveTo(github, issueNumber, issue.labels, 'triage');
      await github.addComment(issueNumber, formatTriageComment(verdict.reasons));
      report.returnedToTriage.push(issueNumber);
      return;
    }

    // Kiểm tra trùng lặp phạm vi file (sau khi assessIssue hợp lệ, trước tryClaim):
    const currentHolders = await getHolders();
    const candidate = {
      issueNumber,
      scope: verdict.form.scopePatterns,
    };
    const selection = selectDispatchable([candidate], currentHolders, holdingStatuses);
    if (selection.deferred.length > 0) {
      const def = selection.deferred[0]!;
      report.skipped.push({
        issue: issueNumber,
        reason: 'scope-overlap',
        blockedBy: def.blockedBy,
      });
      deps.log?.(
        `[sync-queue-tick] Issue #${issueNumber} hoãn dispatch vì trùng phạm vi file với issue: ${def.blockedBy.join(', ')}`,
      );
      return;
    }

    const claim = await tryClaim(github, issueNumber, runId);
    if (!claim.won) {
      report.skipped.push({ issue: issueNumber, reason: claim.reason });
      return;
    }

    const claimedLabels = [...issue.labels.filter((label) => label !== 'status:ready'), 'status:claimed'];
    const spawnFailuresBefore = comments.filter((comment) => comment.body.includes(SPAWN_FAILURE_MARKER)).length;
    try {
      const started = await deps.dispatchWorker({ issueNumber, title: issue.title, agent: verdict.agent, form: verdict.form });
      await moveTo(github, issueNumber, claimedLabels, 'in-progress');
      await upsertProgressComment(github, issueNumber, {
        worktree: started.worktree,
        agent: verdict.agent,
        dispatchId: started.dispatchId,
        rows: [],
        updatedAt: now()
      });
      report.dispatched.push(issueNumber);
      // Dispatch thành công -> thêm vào currentHolders (status: 'in-progress') để giữ khoá cho candidate sau:
      currentHolders.push({
        issueNumber,
        scope: verdict.form.scopePatterns,
        status: 'in-progress',
      });
    } catch (error) {
      // Khởi chạy lỗi: trả hàng đợi, nhưng đủ số lần thì chặn (tránh vòng spawn vô hạn tốn tiền agent).
      const blocked = spawnFailuresBefore + 1 >= MAX_SPAWN_FAILURES;
      const reason = error instanceof Error ? error.message : String(error);
      await moveTo(github, issueNumber, claimedLabels, blocked ? 'blocked' : 'ready');
      await github.addComment(
        issueNumber,
        `${SPAWN_FAILURE_MARKER}
🤖 Fleet khởi chạy worker lỗi (lần ${spawnFailuresBefore + 1}/${MAX_SPAWN_FAILURES}): ${reason}
` +
          (blocked ? 'Đã đặt `status:blocked`; sửa nguyên nhân rồi gắn lại `status:ready`.' : 'Trả về `status:ready`.')
      );
      report.failed.push({ issue: issueNumber, error: reason });
    }
  }

  const ready = [...(await github.listReadyIssues(READY_LIST_LIMIT))].sort((a, b) => a.number - b.number);
  for (const summary of ready) {
    if (report.dispatched.length >= limit) {
      report.skipped.push({ issue: summary.number, reason: 'tick-limit' });
      continue;
    }
    try {
      await handleIssue(summary.number);
    } catch (error) {
      report.failed.push({ issue: summary.number, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}
