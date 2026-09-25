import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GateReport } from '../iteration-guard/gate-report.ts';
import { InMemoryGithub } from './in-memory-github-port.ts';
import { PROGRESS_MARKER, findProgressComment, progressRowsFromReports, renderProgressComment, upsertProgressComment } from './progress-comment.ts';
import type { ProgressState } from './progress-comment.ts';
import { parseStateMarker } from './state-marker.ts';

const T0 = new Date('2026-09-25T03:42:00Z');

function state(overrides: Partial<ProgressState> = {}): ProgressState {
  return {
    worktree: 'gh-142-fix-lightbox-thumb',
    agent: 'claude',
    dispatchId: 'ctx_94afe26a9dc3',
    rows: [{ iteration: 1, result: 'red', note: '`npm test`: test-shared.mjs' }],
    updatedAt: T0,
    ...overrides
  };
}

function githubWithIssue(): InMemoryGithub {
  const github = new InMemoryGithub();
  github.addIssue(142, { body: '', labels: ['status:in-progress'] });
  return github;
}

describe('renderProgressComment', () => {
  it('có marker, bảng vòng lặp, giờ UTC+7 và marker trạng thái để khôi phục', () => {
    const body = renderProgressComment(state());
    assert.ok(body.startsWith(PROGRESS_MARKER));
    assert.match(body, /### 🤖 Tiến độ Fleet — `gh-142-fix-lightbox-thumb` \(agent: claude\)/);
    assert.match(body, /\| 1 \| 🔴 \| `npm test`: test-shared\.mjs \|/);
    assert.match(body, /_Cập nhật: 2026-09-25 10:42 \(UTC\+7\)_/);
    assert.deepEqual(parseStateMarker(body), { dispatch: 'ctx_94afe26a9dc3', iteration: 1, worktree: 'gh-142-fix-lightbox-thumb' });
  });

  it('ký tự `|` và xuống dòng trong ghi chú không phá bảng', () => {
    const body = renderProgressComment(state({ rows: [{ iteration: 1, result: 'red', note: 'a | b\nc' }] }));
    assert.match(body, /\| 1 \| 🔴 \| a \\\| b c \|/);
  });

  it('vòng xanh hiện 🟢', () => {
    assert.match(renderProgressComment(state({ rows: [{ iteration: 3, result: 'green', note: '' }] })), /\| 3 \| 🟢 \|/);
  });
});

describe('progressRowsFromReports', () => {
  it('đánh số theo thứ tự nhận (đã khử trùng), không theo số agent khai', () => {
    const reports: GateReport[] = [
      { messageId: 'm1', result: 'red', claimedIteration: 99, failing: 'typecheck' },
      { messageId: 'm1', result: 'red', claimedIteration: 99, failing: 'typecheck' },
      { messageId: 'm2', result: 'green' }
    ];
    assert.deepEqual(progressRowsFromReports(reports), [
      { iteration: 1, result: 'red', note: 'typecheck' },
      { iteration: 2, result: 'green', note: '' }
    ]);
  });
});

describe('upsertProgressComment', () => {
  it('lần đầu → created, đúng một comment', async () => {
    const github = githubWithIssue();
    assert.equal(await upsertProgressComment(github.port(), 142, state()), 'created');
    assert.equal(github.commentsOf(142).length, 1);
  });

  it('các lần sau SỬA TẠI CHỖ, không đăng comment mới mỗi vòng (blueprint §3.3)', async () => {
    const github = githubWithIssue();
    const port = github.port();
    await upsertProgressComment(port, 142, state());
    const second = state({ rows: [...state().rows, { iteration: 2, result: 'green', note: '' }], updatedAt: new Date(T0.getTime() + 60_000) });
    assert.equal(await upsertProgressComment(port, 142, second), 'updated');

    const comments = github.commentsOf(142);
    assert.equal(comments.length, 1);
    assert.match(comments[0]?.body ?? '', /\| 2 \| 🟢 \|/);
  });

  it('chỉ khác dòng "Cập nhật" → unchanged, không tốn lượt gọi API', async () => {
    const github = githubWithIssue();
    const port = github.port();
    await upsertProgressComment(port, 142, state());
    const later = state({ updatedAt: new Date(T0.getTime() + 5 * 60_000) });
    assert.equal(await upsertProgressComment(port, 142, later), 'unchanged');
  });

  it('nhận danh sách comment đã đọc sẵn để khỏi gọi readIssue thêm', async () => {
    const github = githubWithIssue();
    let reads = 0;
    const port = github.port();
    const counting = { ...port, readIssue: async (n: number) => { reads += 1; return port.readIssue(n); } };
    await upsertProgressComment(counting, 142, state(), []);
    assert.equal(reads, 0);
  });

  it('findProgressComment bỏ qua comment thường', async () => {
    const github = githubWithIssue();
    await github.port().addComment(142, 'chào mọi người');
    assert.equal(findProgressComment(github.commentsOf(142)), undefined);
  });
});
