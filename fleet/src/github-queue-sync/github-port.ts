export interface QueueIssueSummary {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
}

export interface QueueIssue extends QueueIssueSummary {
  readonly body: string;
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  /** ISO 8601 do GitHub cấp — độ chính xác đến giây. */
  readonly createdAt: string;
}

export interface LabelChange {
  readonly add: readonly string[];
  readonly remove: readonly string[];
}

/**
 * Mọi thứ `github-queue-sync` cần từ GitHub, ở mức khái niệm. Bản thật là `createOrcaGithubPort`
 * (RPC `github.*` của Orca, dùng token/`gh` của người dùng đã đăng nhập trong Orca); test dùng bản giả.
 * Mọi hàm ném lỗi khi GitHub từ chối — KHÔNG được trả "rỗng" thay cho lỗi.
 */
export interface GithubPort {
  /** Issue đang mở mang nhãn `status:ready`, cũ nhất trước. */
  listReadyIssues(limit: number): Promise<QueueIssueSummary[]>;
  /** Issue đang mở mang nhãn `status:claimed`, `status:in-progress` hoặc `status:review`. */
  listActiveIssues(limit: number): Promise<QueueIssueSummary[]>;
  /** Một lượt gọi cho cả issue lẫn comment — tiết kiệm rate limit `gh`. */
  readIssue(issueNumber: number): Promise<{ readonly issue: QueueIssue; readonly comments: readonly IssueComment[] }>;
  addComment(issueNumber: number, body: string): Promise<IssueComment>;
  updateComment(commentId: number, body: string): Promise<void>;
  /** Thêm và gỡ nhãn trong MỘT lệnh, để không có lúc nào issue mang hai nhãn status. */
  changeLabels(issueNumber: number, change: LabelChange): Promise<void>;
}
