import type { GithubPort, IssueComment, QueueIssue, QueueIssueSummary } from './github-port.ts';

/** Khớp chữ ký `callOrca` của `orca-rpc-client`. */
export type RpcCall = (method: string, params?: unknown) => Promise<unknown>;

export interface OrcaGithubPortConfig {
  /** Selector repo của Orca, ví dụ `id:<uuid>` hoặc `path:C:/repos/hungdaitool`. */
  readonly repoSelector: string;
}

const READY_QUERY = 'is:issue is:open label:"status:ready"';

const ACTIVE_STATUS_QUERIES = [
  'is:issue is:open label:"status:claimed"',
  'is:issue is:open label:"status:in-progress"',
  'is:issue is:open label:"status:review"',
] as const;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Orca trả về ${what} không đúng dạng`);
  }
  return value as Record<string, unknown>;
}

function asComment(value: unknown): IssueComment {
  const raw = asRecord(value, 'comment');
  if (typeof raw.id !== 'number' || typeof raw.body !== 'string' || typeof raw.createdAt !== 'string') {
    throw new Error('Orca trả về comment thiếu id/body/createdAt');
  }
  return { id: raw.id, body: raw.body, createdAt: raw.createdAt };
}

/** Mutation của Orca trả `{ ok: true }` hoặc `{ ok: false, error }` — lỗi phải ném, không được nuốt. */
function assertMutationOk(result: unknown, action: string): Record<string, unknown> {
  const raw = asRecord(result, action);
  if (raw.ok !== true) {
    throw new Error(`${action} thất bại: ${typeof raw.error === 'string' ? raw.error : 'không rõ lý do'}`);
  }
  return raw;
}

function toLabels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((label): label is string => typeof label === 'string') : [];
}

/**
 * Bản thật của `GithubPort` qua RPC `github.*` của Orca (quyết định §6.1: dùng token của Orca, không
 * thêm PAT). Các method này gọi `gh` CLI, nên `gh` phải được cài và đăng nhập trên máy chạy Orca.
 */
export function createOrcaGithubPort(
  rpc: RpcCall,
  config: OrcaGithubPortConfig
): GithubPort & { assertAvailable(): Promise<void> } {
  const repo = config.repoSelector;
  let slug: { owner: string; repo: string; host?: string } | undefined;

  async function resolveSlug(): Promise<{ owner: string; repo: string; host?: string }> {
    if (slug === undefined) {
      const raw = asRecord(await rpc('github.repoSlug', { repo }), 'repoSlug');
      if (typeof raw.owner !== 'string' || typeof raw.repo !== 'string') {
        throw new Error('Orca không xác định được owner/repo (repo chưa có remote GitHub?)');
      }
      slug = { owner: raw.owner, repo: raw.repo, ...(typeof raw.host === 'string' ? { host: raw.host } : {}) };
    }
    return slug;
  }

  return {
    /**
     * Gọi lúc Fleet khởi động. Bắt buộc vì khi `gh` vắng mặt, `github.listLabels` trả `[]` chứ không
     * báo lỗi: nếu không kiểm trước, Fleet sẽ tưởng "không có issue nào" rồi chạy im lặng mãi.
     */
    async assertAvailable(): Promise<void> {
      const raw = asRecord(await rpc('github.rateLimit', {}), 'rateLimit');
      if (raw.ok === false) {
        throw new Error(
          `RPC github.* của Orca không dùng được: ${typeof raw.error === 'string' ? raw.error : 'không rõ lý do'}. ` +
            'Cài GitHub CLI (`winget install GitHub.cli`) và chạy `gh auth login`.'
        );
      }
    },

    async listReadyIssues(limit): Promise<QueueIssueSummary[]> {
      const raw = asRecord(await rpc('github.listWorkItems', { repo, limit, query: READY_QUERY }), 'listWorkItems');
      if (raw.errors !== undefined && asRecord(raw.errors, 'errors').issues !== undefined) {
        throw new Error(`Không đọc được danh sách issue: ${JSON.stringify(asRecord(raw.errors, 'errors').issues)}`);
      }
      const items = Array.isArray(raw.items) ? raw.items : [];
      return items
        .map((item) => asRecord(item, 'work item'))
        // Kiểm lại phía client: không dựa hoàn toàn vào cú pháp query của Orca.
        .filter((item) => item.type === 'issue' && toLabels(item.labels).includes('status:ready'))
        .map((item) => ({
          number: item.number as number,
          title: String(item.title ?? ''),
          labels: toLabels(item.labels)
        }));
    },

    async listActiveIssues(limit): Promise<QueueIssueSummary[]> {
      const activeLabels = ['status:claimed', 'status:in-progress', 'status:review'];
      const byNumber = new Map<number, QueueIssueSummary>();

      for (const query of ACTIVE_STATUS_QUERIES) {
        const raw = asRecord(await rpc('github.listWorkItems', { repo, limit, query }), 'listWorkItems');
        if (raw.errors !== undefined && asRecord(raw.errors, 'errors').issues !== undefined) {
          throw new Error(`Không đọc được danh sách issue: ${JSON.stringify(asRecord(raw.errors, 'errors').issues)}`);
        }
        const items = Array.isArray(raw.items) ? raw.items : [];
        for (const rawItem of items) {
          const item = asRecord(rawItem, 'work item');
          const labels = toLabels(item.labels);
          if (item.type === 'issue' && labels.some((l) => activeLabels.includes(l))) {
            const num = item.number as number;
            if (!byNumber.has(num)) {
              byNumber.set(num, {
                number: num,
                title: String(item.title ?? ''),
                labels,
              });
            }
          }
        }
      }

      return Array.from(byNumber.values()).slice(0, limit);
    },

    async readIssue(issueNumber) {
      const raw = asRecord(await rpc('github.workItemDetails', { repo, number: issueNumber, type: 'issue' }), 'workItemDetails');
      const item = asRecord(raw.item, 'issue');
      const issue: QueueIssue = {
        number: issueNumber,
        title: String(item.title ?? ''),
        labels: toLabels(item.labels),
        body: typeof raw.body === 'string' ? raw.body : ''
      };
      const comments = Array.isArray(raw.comments) ? raw.comments.map(asComment) : [];
      return { issue, comments };
    },

    async addComment(issueNumber, body) {
      const raw = assertMutationOk(await rpc('github.addIssueComment', { repo, number: issueNumber, body }), 'Đăng comment');
      return asComment(raw.comment);
    },

    async updateComment(commentId, body) {
      const target = await resolveSlug();
      assertMutationOk(await rpc('github.project.updateIssueCommentBySlug', { ...target, commentId, body }), 'Sửa comment');
    },

    async changeLabels(issueNumber, change) {
      assertMutationOk(
        await rpc('github.updateIssue', {
          repo,
          number: issueNumber,
          updates: { addLabels: [...change.add], removeLabels: [...change.remove] }
        }),
        'Đổi nhãn'
      );
    }
  };
}
