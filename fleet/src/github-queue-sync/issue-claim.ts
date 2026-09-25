import type { GithubPort, IssueComment } from './github-port.ts';
import { planTransition, readStatus } from './label-state-machine.ts';

const CLAIM_PATTERN = /<!-- orca-fleet:claim run=([\w-]+) -->/;

/**
 * Hai lần claim cách nhau quá ngưỡng này không tranh nhau nữa. Cần vì issue có thể được trả về
 * `ready` (khởi chạy lỗi, người dùng gắn lại sau `blocked`) trong khi comment claim cũ vẫn còn:
 * không có ngưỡng thì claim cũ luôn "đến trước" và mọi lần bốc sau đều thua mãi mãi.
 * Hai Fleet đang poll đều đặn 60 s nên tranh nhau trong vài giây, xa dưới ngưỡng.
 */
export const CLAIM_RACE_WINDOW_MS = 120_000;

export function claimMarker(runId: string): string {
  return `<!-- orca-fleet:claim run=${runId} -->`;
}

export function parseClaimRunId(body: string): string | undefined {
  return CLAIM_PATTERN.exec(body)?.[1];
}

export type ClaimOutcome =
  | { readonly won: true; readonly claimCommentId: number }
  | { readonly won: false; readonly reason: 'not-ready' | 'lost-race' | 'claim-not-visible' };

function claimOrder(a: IssueComment, b: IssueComment): number {
  // Comment id tăng dần theo thời gian tạo; dùng làm phân xử khi cùng giây.
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id;
}

/**
 * "Comment đầu tiên thắng" (blueprint §3.3). GitHub không có khoá nên:
 * 1. đăng comment claim, 2. đọc lại toàn bộ comment, 3. claim sớm nhất trong cửa sổ tranh chấp thắng.
 *
 * Khác bản mẫu trong blueprint: phân xử xong mới đổi nhãn. Bên thua không đụng nhãn nào, nên hai
 * Fleet không dẫm nhau và issue không đổi trạng thái vì một claim thua.
 */
export async function tryClaim(
  github: GithubPort,
  issueNumber: number,
  runId: string,
  raceWindowMs: number = CLAIM_RACE_WINDOW_MS
): Promise<ClaimOutcome> {
  const before = await github.readIssue(issueNumber);
  const status = readStatus(before.issue.labels);
  if (status.kind !== 'one' || status.status !== 'ready') {
    return { won: false, reason: 'not-ready' };
  }

  const mine = await github.addComment(issueNumber, `${claimMarker(runId)}\n🤖 Fleet nhận task lúc ${new Date().toISOString()}`);

  const { comments } = await github.readIssue(issueNumber);
  if (!comments.some((comment) => comment.id === mine.id)) {
    // Đọc lại chưa thấy comment của chính mình (GitHub trễ đồng bộ): không đủ dữ kiện để phân xử.
    return { won: false, reason: 'claim-not-visible' };
  }

  const mineTime = Date.parse(mine.createdAt);
  const contenders = comments
    .filter((comment) => parseClaimRunId(comment.body) !== undefined)
    .filter((comment) => Math.abs(Date.parse(comment.createdAt) - mineTime) <= raceWindowMs)
    .sort(claimOrder);
  const winner = contenders[0];
  // Claim sớm hơn nhưng cùng runId cũng là của mình: lần bốc trước đã đăng claim rồi đổi nhãn lỗi.
  if (winner === undefined || parseClaimRunId(winner.body) !== runId) {
    return { won: false, reason: 'lost-race' };
  }

  const plan = planTransition(before.issue.labels, 'claimed');
  if (!plan.ok) {
    return { won: false, reason: 'not-ready' };
  }
  await github.changeLabels(issueNumber, { add: plan.addLabels, remove: plan.removeLabels });
  return { won: true, claimCommentId: winner.id };
}
