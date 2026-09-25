import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOrcaGithubPort } from './orca-github-port.ts';
import type { RpcCall } from './orca-github-port.ts';

interface Call {
  method: string;
  params: unknown;
}

/** RPC giả: trả về theo tên method, ghi lại mọi lượt gọi để kiểm tra tham số. */
function fakeRpc(handlers: Record<string, unknown | ((params: unknown) => unknown)>): { rpc: RpcCall; calls: Call[] } {
  const calls: Call[] = [];
  const rpc: RpcCall = async (method, params) => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (handler === undefined) {
      throw new Error(`method không giả lập: ${method}`);
    }
    return typeof handler === 'function' ? handler(params) : handler;
  };
  return { rpc, calls };
}

const CONFIG = { repoSelector: 'id:8558e6bb' };

describe('createOrcaGithubPort', () => {
  it('assertAvailable: `gh` vắng mặt (spawn gh ENOENT) → ném lỗi kèm hướng dẫn cài', async () => {
    const { rpc } = fakeRpc({ 'github.rateLimit': { ok: false, error: 'spawn gh ENOENT' } });
    await assert.rejects(createOrcaGithubPort(rpc, CONFIG).assertAvailable(), /spawn gh ENOENT[\s\S]*gh auth login/);
  });

  it('assertAvailable: rateLimit ok → không ném', async () => {
    const { rpc } = fakeRpc({ 'github.rateLimit': { ok: true, remaining: 4000 } });
    await createOrcaGithubPort(rpc, CONFIG).assertAvailable();
  });

  it('listReadyIssues: gửi query status:ready và lọc lại phía client (bỏ PR, bỏ item sai nhãn)', async () => {
    const { rpc, calls } = fakeRpc({
      'github.listWorkItems': {
        items: [
          { type: 'issue', number: 10, title: 'A', labels: ['status:ready', 'size:S'] },
          { type: 'pr', number: 11, title: 'PR', labels: ['status:ready'] },
          { type: 'issue', number: 12, title: 'B', labels: ['status:triage'] }
        ]
      }
    });
    const issues = await createOrcaGithubPort(rpc, CONFIG).listReadyIssues(20);
    assert.deepEqual(issues, [{ number: 10, title: 'A', labels: ['status:ready', 'size:S'] }]);
    assert.deepEqual(calls[0], {
      method: 'github.listWorkItems',
      params: { repo: 'id:8558e6bb', limit: 20, query: 'is:issue is:open label:"status:ready"' }
    });
  });

  it('listReadyIssues: Orca báo lỗi phía issues → ném, KHÔNG coi là "không có issue"', async () => {
    const { rpc } = fakeRpc({ 'github.listWorkItems': { items: [], errors: { issues: { message: 'gh auth' } } } });
    await assert.rejects(createOrcaGithubPort(rpc, CONFIG).listReadyIssues(5), /Không đọc được danh sách issue/);
  });

  it('readIssue: gộp issue và comment từ một lượt workItemDetails', async () => {
    const { rpc, calls } = fakeRpc({
      'github.workItemDetails': {
        item: { title: 'Tiêu đề', labels: ['status:ready'] },
        body: '### 1. Mục tiêu đo được',
        comments: [{ id: 5, body: 'x', createdAt: '2026-09-26T03:00:00Z', author: 'a' }]
      }
    });
    const { issue, comments } = await createOrcaGithubPort(rpc, CONFIG).readIssue(142);
    assert.deepEqual(issue, { number: 142, title: 'Tiêu đề', labels: ['status:ready'], body: '### 1. Mục tiêu đo được' });
    assert.deepEqual(comments, [{ id: 5, body: 'x', createdAt: '2026-09-26T03:00:00Z' }]);
    assert.deepEqual(calls[0]?.params, { repo: 'id:8558e6bb', number: 142, type: 'issue' });
  });

  it('readIssue: comment thiếu trường hoặc phản hồi sai dạng → ném lỗi rõ ràng', async () => {
    const bad = fakeRpc({ 'github.workItemDetails': { item: {}, body: '', comments: [{ id: 'x' }] } });
    await assert.rejects(createOrcaGithubPort(bad.rpc, CONFIG).readIssue(1), /thiếu id\/body\/createdAt/);
    const wrong = fakeRpc({ 'github.workItemDetails': 'oops' });
    await assert.rejects(createOrcaGithubPort(wrong.rpc, CONFIG).readIssue(1), /không đúng dạng/);
  });

  it('addComment: trả comment vừa tạo (có id); ok:false → ném', async () => {
    const good = fakeRpc({ 'github.addIssueComment': { ok: true, comment: { id: 77, body: 'b', createdAt: '2026-09-26T03:00:01Z' } } });
    assert.deepEqual(await createOrcaGithubPort(good.rpc, CONFIG).addComment(142, 'b'), { id: 77, body: 'b', createdAt: '2026-09-26T03:00:01Z' });
    assert.deepEqual(good.calls[0]?.params, { repo: 'id:8558e6bb', number: 142, body: 'b' });

    const bad = fakeRpc({ 'github.addIssueComment': { ok: false, error: 'rate limited' } });
    await assert.rejects(createOrcaGithubPort(bad.rpc, CONFIG).addComment(142, 'b'), /Đăng comment thất bại: rate limited/);
  });

  it('changeLabels: thêm và gỡ trong MỘT lệnh updateIssue; ok:false → ném', async () => {
    const good = fakeRpc({ 'github.updateIssue': { ok: true } });
    await createOrcaGithubPort(good.rpc, CONFIG).changeLabels(142, { add: ['status:claimed'], remove: ['status:ready'] });
    assert.equal(good.calls.length, 1);
    assert.deepEqual(good.calls[0]?.params, {
      repo: 'id:8558e6bb',
      number: 142,
      updates: { addLabels: ['status:claimed'], removeLabels: ['status:ready'] }
    });

    const bad = fakeRpc({ 'github.updateIssue': { ok: false, error: "'status:claimed' not found" } });
    await assert.rejects(createOrcaGithubPort(bad.rpc, CONFIG).changeLabels(1, { add: ['status:claimed'], remove: [] }), /not found/);
  });

  it('updateComment: tra slug một lần rồi dùng lại, gọi project.updateIssueCommentBySlug', async () => {
    const { rpc, calls } = fakeRpc({
      'github.repoSlug': { owner: 'hungdaimedia-gif', repo: 'hungdaitool', host: 'github.com' },
      'github.project.updateIssueCommentBySlug': { ok: true }
    });
    const port = createOrcaGithubPort(rpc, CONFIG);
    await port.updateComment(5, 'mới');
    await port.updateComment(6, 'mới hơn');

    assert.equal(calls.filter((call) => call.method === 'github.repoSlug').length, 1);
    assert.deepEqual(calls[1]?.params, { owner: 'hungdaimedia-gif', repo: 'hungdaitool', host: 'github.com', commentId: 5, body: 'mới' });
  });

  it('updateComment: repo không có remote GitHub → ném thay vì gọi với slug rỗng', async () => {
    const { rpc } = fakeRpc({ 'github.repoSlug': null });
    await assert.rejects(createOrcaGithubPort(rpc, CONFIG).updateComment(1, 'x'), /không đúng dạng/);
  });

  it('listActiveIssues: 3 lệnh query đúng nhãn, gộp trùng, lọc nhãn sai phía client, ném lỗi khi Orca báo errors.issues', async () => {
    // 1. Kiểm tra 3 query, lọc PR/nhãn sai, và gộp trùng
    let queryIndex = 0;
    const { rpc, calls } = fakeRpc({
      'github.listWorkItems': (params: unknown) => {
        const p = params as { query: string };
        queryIndex += 1;
        if (p.query.includes('status:claimed')) {
          return {
            items: [
              { type: 'issue', number: 10, title: 'Issue 10', labels: ['status:claimed'] },
              { type: 'pr', number: 11, title: 'PR 11', labels: ['status:claimed'] },
            ]
          };
        }
        if (p.query.includes('status:in-progress')) {
          return {
            items: [
              { type: 'issue', number: 10, title: 'Issue 10 duplicate', labels: ['status:in-progress'] },
              { type: 'issue', number: 20, title: 'Issue 20', labels: ['status:in-progress'] },
              { type: 'issue', number: 25, title: 'Issue 25', labels: ['status:wrong'] },
            ]
          };
        }
        if (p.query.includes('status:review')) {
          return {
            items: [
              { type: 'issue', number: 30, title: 'Issue 30', labels: ['status:review'] },
            ]
          };
        }
        return { items: [] };
      }
    });

    const port = createOrcaGithubPort(rpc, CONFIG);
    const result = await port.listActiveIssues(10);

    // Đúng 3 query được gửi
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.params && (calls[0].params as { query: string }).query, 'is:issue is:open label:"status:claimed"');
    assert.equal(calls[1]?.params && (calls[1].params as { query: string }).query, 'is:issue is:open label:"status:in-progress"');
    assert.equal(calls[2]?.params && (calls[2].params as { query: string }).query, 'is:issue is:open label:"status:review"');

    // Gộp trùng (10 chỉ xuất hiện 1 lần), lọc PR (11 bị bỏ), lọc nhãn sai (25 bị bỏ)
    assert.deepEqual(result, [
      { number: 10, title: 'Issue 10', labels: ['status:claimed'] },
      { number: 20, title: 'Issue 20', labels: ['status:in-progress'] },
      { number: 30, title: 'Issue 30', labels: ['status:review'] },
    ]);

    // 2. Ném lỗi khi Orca báo errors.issues
    const errRpc = fakeRpc({
      'github.listWorkItems': { items: [], errors: { issues: { message: 'rate limit exceeded' } } }
    });
    await assert.rejects(
      createOrcaGithubPort(errRpc.rpc, CONFIG).listActiveIssues(10),
      /Không đọc được danh sách issue/
    );
  });
});
