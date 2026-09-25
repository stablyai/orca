import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { READY_LABELS, buildIssueBody } from './agent-task-issue-fixture.ts';
import { InMemoryGithub } from './in-memory-github-port.ts';
import { PROGRESS_MARKER } from './progress-comment.ts';
import { MAX_SPAWN_FAILURES, SPAWN_FAILURE_MARKER, syncQueueTick } from './sync-queue-tick.ts';
import type { DispatchRequest, DispatchWorker } from './sync-queue-tick.ts';

const okWorker: DispatchWorker = async (request) => ({ dispatchId: `ctx_${request.issueNumber}`, worktree: `gh-${request.issueNumber}-work` });

function statusOf(github: InMemoryGithub, number: number): string[] {
  return github.labelsOf(number).filter((label) => label.startsWith('status:'));
}

function setup(...numbers: number[]): InMemoryGithub {
  const github = new InMemoryGithub();
  const multi = numbers.length > 1;
  for (const number of numbers) {
    github.addIssue(number, {
      title: `Task ${number}`,
      body: multi ? buildIssueBody({ scope: `scripts/task-${number}.mjs` }) : buildIssueBody(),
      labels: [...READY_LABELS]
    });
  }
  return github;
}

describe('syncQueueTick', () => {
  it('issue đủ spec → claim, giao worker, chuyển in-progress, đăng comment tiến độ', async () => {
    const github = setup(142);
    const requests: DispatchRequest[] = [];
    const report = await syncQueueTick({
      github: github.port(),
      runId: 'fleet-A',
      dispatchWorker: async (request) => {
        requests.push(request);
        return okWorker(request);
      }
    });

    assert.deepEqual(report, { returnedToTriage: [], dispatched: [142], skipped: [], failed: [] });
    assert.deepEqual(statusOf(github, 142), ['status:in-progress']);
    assert.equal(requests[0]?.agent, 'claude');
    assert.deepEqual(requests[0]?.form.scopePatterns, ['.github/workflows/ci.yml']);
    assert.ok(github.commentsOf(142).some((comment) => comment.body.includes(PROGRESS_MARKER)));
  });

  it('issue thiếu spec → trả về triage kèm comment lý do, KHÔNG giao worker', async () => {
    const github = new InMemoryGithub();
    github.addIssue(5, { body: buildIssueBody({ objective: '', scope: '**' }), labels: [...READY_LABELS] });
    let dispatched = 0;
    const report = await syncQueueTick({
      github: github.port(),
      runId: 'fleet-A',
      dispatchWorker: async (request) => {
        dispatched += 1;
        return okWorker(request);
      }
    });

    assert.deepEqual(report.returnedToTriage, [5]);
    assert.equal(dispatched, 0);
    assert.deepEqual(statusOf(github, 5), ['status:triage']);
    assert.match(github.commentsOf(5)[0]?.body ?? '', /mục 1 \(Mục tiêu đo được\) đang để trống/);
  });

  it('vòng poll sau không lặp lại comment triage (issue đã rời ready)', async () => {
    const github = new InMemoryGithub();
    github.addIssue(5, { body: buildIssueBody({ objective: '' }), labels: [...READY_LABELS] });
    const deps = { github: github.port(), runId: 'fleet-A', dispatchWorker: okWorker };
    await syncQueueTick(deps);
    await syncQueueTick(deps);
    assert.equal(github.commentsOf(5).length, 1);
  });

  it('hai Fleet cùng quét một hàng đợi → mỗi issue chỉ được giao MỘT lần', async () => {
    const github = setup(1, 2, 3);
    const dispatchedBy: string[] = [];
    const worker = (name: string): DispatchWorker => async (request) => {
      dispatchedBy.push(`${name}:${request.issueNumber}`);
      return okWorker(request);
    };
    await Promise.all([
      syncQueueTick({ github: github.port(), runId: 'fleet-A', dispatchWorker: worker('A'), maxIssuesPerTick: 10 }),
      syncQueueTick({ github: github.port(), runId: 'fleet-B', dispatchWorker: worker('B'), maxIssuesPerTick: 10 })
    ]);

    const issuesDispatched = dispatchedBy.map((entry) => entry.split(':')[1]).sort();
    assert.deepEqual(issuesDispatched, ['1', '2', '3'], 'mỗi issue đúng một lần, không trùng');
    for (const number of [1, 2, 3]) {
      assert.deepEqual(statusOf(github, number), ['status:in-progress']);
    }
  });

  it('tôn trọng trần số issue mỗi vòng', async () => {
    const github = setup(1, 2, 3);
    const report = await syncQueueTick({ github: github.port(), runId: 'fleet-A', dispatchWorker: okWorker, maxIssuesPerTick: 2 });
    assert.deepEqual(report.dispatched, [1, 2]);
    assert.deepEqual(report.skipped, [{ issue: 3, reason: 'tick-limit' }]);
    assert.deepEqual(statusOf(github, 3), ['status:ready']);
  });

  it('issue vừa bị Fleet khác giành (hết ready giữa lúc liệt kê và đọc) → skipped, không báo lỗi', async () => {
    const github = setup(9);
    const port = github.port();
    const stale = {
      ...port,
      listReadyIssues: async (limit: number) => {
        const list = await port.listReadyIssues(limit);
        const issue = github.issues.get(9);
        assert.ok(issue);
        issue.labels = issue.labels.filter((label) => label !== 'status:ready').concat('status:in-progress');
        return list;
      }
    };
    const report = await syncQueueTick({ github: stale, runId: 'fleet-A', dispatchWorker: okWorker });
    assert.deepEqual(report, { returnedToTriage: [], dispatched: [], skipped: [{ issue: 9, reason: 'no-longer-ready' }], failed: [] });
    assert.deepEqual(statusOf(github, 9), ['status:in-progress']);
  });

  it('khởi chạy worker lỗi lần đầu → trả về ready kèm comment', async () => {
    const github = setup(142);
    const report = await syncQueueTick({
      github: github.port(),
      runId: 'fleet-A',
      dispatchWorker: async () => {
        throw new Error('orca worker-start lỗi');
      }
    });
    assert.deepEqual(report.failed, [{ issue: 142, error: 'orca worker-start lỗi' }]);
    assert.deepEqual(statusOf(github, 142), ['status:ready']);
    assert.match(github.commentsOf(142).at(-1)?.body ?? '', new RegExp(`lần 1/${MAX_SPAWN_FAILURES}`));
  });

  it(`sau ${MAX_SPAWN_FAILURES} lần khởi chạy lỗi → status:blocked, không bốc lại mãi`, async () => {
    const github = setup(142);
    const deps = {
      github: github.port(),
      runId: 'fleet-A',
      dispatchWorker: async (): Promise<never> => {
        throw new Error('hỏng');
      }
    };
    // Mỗi lần lỗi là một claim mới; đẩy đồng hồ qua cửa sổ tranh chấp để claim cũ không cản.
    for (let attempt = 1; attempt <= MAX_SPAWN_FAILURES; attempt += 1) {
      assert.deepEqual(statusOf(github, 142), ['status:ready'], `trước lần ${attempt}`);
      await syncQueueTick(deps);
      github.clockMs += 10 * 60_000;
    }
    assert.deepEqual(statusOf(github, 142), ['status:blocked']);
    assert.equal(github.commentsOf(142).filter((comment) => comment.body.includes(SPAWN_FAILURE_MARKER)).length, MAX_SPAWN_FAILURES);

    const before = github.commentsOf(142).length;
    await syncQueueTick(deps);
    assert.equal(github.commentsOf(142).length, before, 'blocked thì vòng sau không đụng vào');
  });

  it('lỗi ở một issue không chặn các issue còn lại', async () => {
    const github = setup(1, 2);
    const port = github.port();
    const flaky = {
      ...port,
      readIssue: async (number: number) => {
        if (number === 1) {
          throw new Error('GitHub 502');
        }
        return port.readIssue(number);
      }
    };
    const report = await syncQueueTick({ github: flaky, runId: 'fleet-A', dispatchWorker: okWorker, maxIssuesPerTick: 5 });
    assert.deepEqual(report.failed, [{ issue: 1, error: 'GitHub 502' }]);
    assert.deepEqual(report.dispatched, [2]);
  });

  it('không có issue ready → báo cáo rỗng, không gọi worker', async () => {
    const github = new InMemoryGithub();
    const report = await syncQueueTick({ github: github.port(), runId: 'fleet-A', dispatchWorker: okWorker });
    assert.deepEqual(report, { returnedToTriage: [], dispatched: [], skipped: [], failed: [] });
  });
});
