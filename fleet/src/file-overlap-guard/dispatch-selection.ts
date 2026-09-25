import { scopesOverlap } from './scope-overlap.ts';

export interface CandidateTask {
  readonly issueNumber: number;
  readonly scope: readonly string[];
}

export interface ActiveTask {
  readonly issueNumber: number;
  readonly scope: readonly string[];
  readonly status: string;
}

export interface DeferredTask {
  readonly issueNumber: number;
  readonly blockedBy: readonly number[];
}

export interface DispatchSelectionResult {
  readonly dispatch: readonly number[];
  readonly deferred: readonly DeferredTask[];
}

/**
 * Lựa chọn các task candidate đủ điều kiện dispatch mà không bị trùng phạm vi file (scope)
 * với các task active đang giữ khoá hoặc các candidate đã được chọn dispatch trước đó trong cùng lượt.
 *
 * Quy tắc:
 * 1. Chỉ các task active có status nằm trong `holding` mới giữ khoá (status 'review' nhả khoá).
 * 2. Duyệt candidates theo thứ tự `issueNumber` tăng dần.
 * 3. Candidate được chọn dispatch sẽ giữ khoá cho các candidate duyệt sau trong cùng lượt gọi.
 * 4. Candidate bị hoãn (deferred) KHÔNG giữ khoá.
 * 5. `blockedBy` được sắp xếp theo số thứ tự tăng dần và loại bỏ trùng lặp.
 * 6. Bỏ qua mục active có `issueNumber` trùng với chính candidate đang xét.
 * 7. Scope rỗng coi như không giao với ai (được dispatch và không chặn ai).
 */
export function selectDispatchable(
  candidates: readonly CandidateTask[],
  active: readonly ActiveTask[],
  holding: readonly string[] = ['claimed', 'in-progress'],
): DispatchSelectionResult {
  const holdingSet = new Set(holding);

  // Danh sách các task hiện đang giữ khoá (ban đầu là active tasks có trạng thái thuộc holding).
  const currentHolders: { issueNumber: number; scope: readonly string[] }[] = active
    .filter((task) => holdingSet.has(task.status))
    .map((task) => ({ issueNumber: task.issueNumber, scope: task.scope }));

  // Duyệt candidates theo issueNumber tăng dần:
  const sortedCandidates = [...candidates].sort((a, b) => a.issueNumber - b.issueNumber);

  const dispatch: number[] = [];
  const deferred: DeferredTask[] = [];

  for (const candidate of sortedCandidates) {
    if (candidate.scope.length === 0) {
      // Scope rỗng coi như không giao với ai -> cho qua và không cản trở ai
      dispatch.push(candidate.issueNumber);
      continue;
    }

    const blockedBySet = new Set<number>();

    for (const holder of currentHolders) {
      // Bỏ qua mục active trùng issueNumber với chính candidate:
      if (holder.issueNumber === candidate.issueNumber) {
        continue;
      }
      if (holder.scope.length === 0) {
        continue;
      }

      const check = scopesOverlap(candidate.scope, holder.scope);
      if (check.overlap) {
        blockedBySet.add(holder.issueNumber);
      }
    }

    if (blockedBySet.size > 0) {
      // Bị chặn: đưa vào deferred, sắp xếp blockedBy tăng dần, không thêm vào currentHolders
      const blockedBy = Array.from(blockedBySet).sort((a, b) => a - b);
      deferred.push({
        issueNumber: candidate.issueNumber,
        blockedBy,
      });
    } else {
      // Đủ điều kiện: dispatch và giữ khoá cho các candidate đến sau trong cùng đợt duyệt
      dispatch.push(candidate.issueNumber);
      currentHolders.push({
        issueNumber: candidate.issueNumber,
        scope: candidate.scope,
      });
    }
  }

  return {
    dispatch,
    deferred,
  };
}
