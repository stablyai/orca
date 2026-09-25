import { callOrca } from './pipe-transport.ts';

export interface OrcaStatus {
  ok: boolean;
  version?: string;
  uptime?: number;
  [key: string]: unknown;
}

export interface WorktreeInfo {
  identity: string;
  repo: string;
  path: string;
  branch: string;
  displayName?: string;
  [key: string]: unknown;
}

export interface OrchestrationRun {
  runId: string;
  objective?: string;
  createdAt: number;
}

export interface WorkerStartParams {
  spec: string;
  worktree?: 'new-top-level' | 'current' | string;
  repo?: string;
  name?: string;
  displayName?: string;
  agent?: string; // 'claude' | 'codex' | 'gemini' | 'opencode'
  baseBranch?: string;
  prompt?: string;
  issue?: number;
}

export interface WorkerStartResult {
  taskId: string;
  dispatchId: string;
  worktree?: WorktreeInfo;
  terminalHandle?: string;
  [key: string]: unknown;
}

export interface OrchestrationCheckResult {
  done: boolean;
  type?: 'worker_done' | 'escalation' | 'question' | string;
  outcome?: 'succeeded' | 'failed' | string;
  messages?: Array<{
    type: string;
    text?: string;
    timestamp: number;
  }>;
  [key: string]: unknown;
}

/**
 * Tập phương thức RPC tối thiểu đã được kiểm chứng với Orca Runtime.
 */
export const orca = {
  /** Lấy trạng thái runtime */
  getStatus(): Promise<OrcaStatus> {
    return callOrca<OrcaStatus>('status.get', {});
  },

  /** Liệt kê danh sách repositories đã đăng ký */
  listRepos(): Promise<Array<{ id: string; name: string; path: string }>> {
    return callOrca('repo.list', {});
  },

  /** Đăng ký thêm repo vào Orca */
  addRepo(repoPath: string): Promise<{ id: string; name: string; path: string }> {
    return callOrca('repo.add', { path: repoPath });
  },

  /** Liệt kê danh sách các Git Worktrees */
  listWorktrees(limit = 50): Promise<WorktreeInfo[]> {
    return callOrca<WorktreeInfo[]>('worktree.list', { limit });
  },

  /** Tạo phiên điều phối mới */
  createOrchestrationRun(objective: string): Promise<OrchestrationRun> {
    return callOrca<OrchestrationRun>('orchestration.runCreate', { objective });
  },

  /**
   * Khởi động một Worker Agent hoàn chỉnh:
   * Tạo worktree mới + mở terminal + gọi agent + tiêm prompt spec
   */
  startWorker(params: WorkerStartParams): Promise<WorkerStartResult> {
    return callOrca<WorkerStartResult>('orchestration.workerStart', params);
  },

  /** Chờ hoặc kiểm tra trạng thái worker */
  checkOrchestration(options: { wait?: boolean; timeoutMs?: number; types?: string[] } = {}): Promise<OrchestrationCheckResult> {
    return callOrca<OrchestrationCheckResult>(
      'orchestration.check',
      {
        wait: options.wait ?? true,
        types: options.types ?? ['worker_done', 'escalation', 'question'],
      },
      options.timeoutMs ?? 120_000
    );
  },

  /** Liệt kê các terminal đang hoạt động */
  listTerminals(worktreeSelector?: string): Promise<Array<{ handle: string; title?: string }>> {
    return callOrca('terminal.list', worktreeSelector ? { worktree: worktreeSelector } : {});
  },

  /** Gửi lệnh/prompt vào terminal */
  sendTerminal(terminalHandle: string, text: string, enter = true): Promise<unknown> {
    return callOrca('terminal.send', { terminal: terminalHandle, text, enter });
  },

  /** Đọc output từ terminal */
  readTerminal(terminalHandle: string, limit = 50): Promise<{ output: string }> {
    return callOrca('terminal.read', { terminal: terminalHandle, limit });
  },

  /** Thêm comment vào GitHub Issue qua token của Orca */
  addGitHubComment(issueNumber: number, body: string, repo?: string): Promise<unknown> {
    return callOrca('github.addIssueComment', { issue: issueNumber, body, repo });
  }
};
