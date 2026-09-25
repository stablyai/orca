import type { GithubPort, IssueComment, LabelChange, QueueIssue, QueueIssueSummary } from './github-port.ts';

interface StoredIssue {
  title: string;
  body: string;
  labels: string[];
  comments: IssueComment[];
}

/**
 * GitHub giả trong bộ nhớ, CHỈ dùng cho test. Mỗi thao tác nhường một lượt microtask để hai Fleet
 * chạy bằng `Promise.all` đan xen từng `await` như hai tiến trình thật.
 */
export class InMemoryGithub {
  readonly issues = new Map<number, StoredIssue>();
  readonly labelChanges: { issueNumber: number; change: LabelChange }[] = [];
  clockMs = Date.parse('2026-09-26T03:00:00Z');
  failNextLabelChange = false;
  hideCommentsFromReads = false;
  private nextCommentId = 1;

  addIssue(number: number, issue: { title?: string; body: string; labels: string[] }): void {
    this.issues.set(number, { title: issue.title ?? `Issue ${number}`, body: issue.body, labels: [...issue.labels], comments: [] });
  }

  labelsOf(number: number): string[] {
    return [...this.stored(number).labels];
  }

  commentsOf(number: number): IssueComment[] {
    return [...this.stored(number).comments];
  }

  /** Mỗi Fleet nhận một port riêng nhưng dùng chung kho dữ liệu. */
  port(): GithubPort {
    const tick = async (): Promise<void> => {
      await Promise.resolve();
    };
    return {
      listReadyIssues: async (limit): Promise<QueueIssueSummary[]> => {
        await tick();
        return [...this.issues.entries()]
          .filter(([, issue]) => issue.labels.includes('status:ready'))
          .slice(0, limit)
          .map(([number, issue]) => ({ number, title: issue.title, labels: [...issue.labels] }));
      },
      readIssue: async (number) => {
        await tick();
        const issue = this.stored(number);
        const view: QueueIssue = { number, title: issue.title, body: issue.body, labels: [...issue.labels] };
        return { issue: view, comments: this.hideCommentsFromReads ? [] : [...issue.comments] };
      },
      addComment: async (number, body) => {
        await tick();
        this.clockMs += 1000;
        const comment: IssueComment = { id: this.nextCommentId++, body, createdAt: new Date(this.clockMs).toISOString() };
        this.stored(number).comments.push(comment);
        return comment;
      },
      updateComment: async (commentId, body) => {
        await tick();
        for (const issue of this.issues.values()) {
          const index = issue.comments.findIndex((comment) => comment.id === commentId);
          const existing = issue.comments[index];
          if (existing !== undefined) {
            issue.comments[index] = { ...existing, body };
            return;
          }
        }
        throw new Error(`Không có comment ${commentId}`);
      },
      changeLabels: async (number, change) => {
        await tick();
        if (this.failNextLabelChange) {
          this.failNextLabelChange = false;
          throw new Error('GitHub từ chối đổi nhãn');
        }
        const issue = this.stored(number);
        issue.labels = issue.labels.filter((label) => !change.remove.includes(label));
        for (const label of change.add) {
          if (!issue.labels.includes(label)) {
            issue.labels.push(label);
          }
        }
        this.labelChanges.push({ issueNumber: number, change });
      }
    };
  }

  private stored(number: number): StoredIssue {
    const issue = this.issues.get(number);
    if (issue === undefined) {
      throw new Error(`Không có issue #${number}`);
    }
    return issue;
  }
}
