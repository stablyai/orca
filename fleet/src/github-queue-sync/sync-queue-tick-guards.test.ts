import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { READY_LABELS, buildIssueBody } from './agent-task-issue-fixture.ts';
import { InMemoryGithub } from './in-memory-github-port.ts';
import { syncQueueTick } from './sync-queue-tick.ts';
import type { DispatchWorker } from './sync-queue-tick.ts';
import type { ResourceVerdict, DeferReason } from '../resource-guard/resource-guard.ts';
import { formatDeferReason } from '../resource-guard/resource-guard.ts';

const okWorker: DispatchWorker = async (request) => ({
  dispatchId: `ctx_${request.issueNumber}`,
  worktree: `gh-${request.issueNumber}-work`,
});

describe('syncQueueTick guards wire-up', () => {
  it('tài nguyên hoãn: không gọi listReadyIssues (dùng spy), deferredByResources đủ lý do, log có chuỗi tiếng Việt từ formatDeferReason; không truyền resourceCheck → không đổi hành vi', async () => {
    const github = new InMemoryGithub();
    github.addIssue(1, { body: buildIssueBody({ scope: 'src/a.ts' }), labels: [...READY_LABELS] });

    let listReadyCalls = 0;
    const originalPort = github.port();
    const portSpy = {
      ...originalPort,
      listReadyIssues: async (limit: number) => {
        listReadyCalls += 1;
        return originalPort.listReadyIssues(limit);
      },
    };

    const logs: string[] = [];
    const reasonLowMem: DeferReason = {
      type: 'low-memory',
      freeMemBytes: 1024 * 1024 * 1024,
      minFreeMemBytes: 4 * 1024 * 1024 * 1024,
    };
    const reasonHighCpu: DeferReason = {
      type: 'high-cpu',
      windowMs: 120_000,
      lowestCpuPercent: 92,
    };
    const resourceVerdictLow: ResourceVerdict = {
      dispatch: false,
      reasons: [reasonLowMem, reasonHighCpu],
    };

    // Khi tài nguyên không đủ:
    const reportDeferred = await syncQueueTick({
      github: portSpy,
      runId: 'fleet-test',
      dispatchWorker: okWorker,
      resourceCheck: () => resourceVerdictLow,
      log: (msg) => logs.push(msg),
    });

    // 1. Không gọi listReadyIssues
    assert.equal(listReadyCalls, 0, 'Không được gọi listReadyIssues khi tài nguyên không đủ');
    // 2. deferredByResources có đủ lý do
    assert.deepEqual(reportDeferred.deferredByResources, [reasonLowMem, reasonHighCpu]);
    assert.equal(reportDeferred.dispatched.length, 0);
    // 3. Log có chuỗi tiếng Việt từ formatDeferReason
    assert.ok(logs.some((l) => l.includes(formatDeferReason(reasonLowMem))));
    assert.ok(logs.some((l) => l.includes(formatDeferReason(reasonHighCpu))));

    // Khi không truyền resourceCheck: hành vi giữ nguyên như cũ (gọi listReadyIssues và dispatch)
    const reportNormal = await syncQueueTick({
      github: portSpy,
      runId: 'fleet-test',
      dispatchWorker: okWorker,
    });
    assert.equal(listReadyCalls, 1);
    assert.deepEqual(reportNormal.dispatched, [1]);
  });

  it('ready [src/*.ts] vs active in-progress [src/a.ts] → skipped scope-overlap blockedBy:[N], không có comment, không đổi nhãn', async () => {
    const github = new InMemoryGithub();
    // Issue 10: đang chạy (in-progress), sửa file src/a.ts
    github.addIssue(10, {
      body: buildIssueBody({ scope: 'src/a.ts' }),
      labels: ['status:in-progress', 'size:S', 'agent:claude'],
    });
    // Issue 20: ready, sửa src/*.ts (giao với src/a.ts)
    github.addIssue(20, {
      body: buildIssueBody({ scope: 'src/*.ts' }),
      labels: [...READY_LABELS],
    });

    const report = await syncQueueTick({
      github: github.port(),
      runId: 'fleet-test',
      dispatchWorker: okWorker,
    });

    // Issue 20 bị skipped vì scope-overlap
    assert.deepEqual(report.skipped, [
      { issue: 20, reason: 'scope-overlap', blockedBy: [10] },
    ]);
    assert.deepEqual(report.dispatched, []);

    // Không để lại comment rác trên issue 20
    assert.equal(github.commentsOf(20).length, 0);
    // Không đổi nhãn issue 20 (vẫn giữ nguyên status:ready)
    assert.ok(github.labelsOf(20).includes('status:ready'));
  });

  it('active review: không chặn (mặc định); holdingStatuses có "review" → chặn', async () => {
    // 1. Mặc định: task active mang status:review thì nhả khoá
    const githubDefault = new InMemoryGithub();
    githubDefault.addIssue(10, {
      body: buildIssueBody({ scope: 'src/a.ts' }),
      labels: ['status:review', 'size:S', 'agent:claude'],
    });
    githubDefault.addIssue(20, {
      body: buildIssueBody({ scope: 'src/*.ts' }),
      labels: [...READY_LABELS],
    });

    const reportDefault = await syncQueueTick({
      github: githubDefault.port(),
      runId: 'fleet-test',
      dispatchWorker: okWorker,
    });
    assert.deepEqual(reportDefault.dispatched, [20]);

    // 2. Khi truyền holdingStatuses có 'review' -> chặn
    const githubHoldingReview = new InMemoryGithub();
    githubHoldingReview.addIssue(10, {
      body: buildIssueBody({ scope: 'src/a.ts' }),
      labels: ['status:review', 'size:S', 'agent:claude'],
    });
    githubHoldingReview.addIssue(20, {
      body: buildIssueBody({ scope: 'src/*.ts' }),
      labels: [...READY_LABELS],
    });

    const reportHolding = await syncQueueTick({
      github: githubHoldingReview.port(),
      runId: 'fleet-test',
      dispatchWorker: okWorker,
      holdingStatuses: ['claimed', 'in-progress', 'review'],
    });
    assert.deepEqual(reportHolding.skipped, [
      { issue: 20, reason: 'scope-overlap', blockedBy: [10] },
    ]);
    assert.deepEqual(reportHolding.dispatched, []);
  });

  it('hai ready giao nhau cùng tick → số nhỏ dispatch, số lớn blockedBy:[số nhỏ]; hai ready không giao → cả hai dispatch', async () => {
    // Cặp 1: hai ready giao nhau (10 [src/a.ts] vs 20 [src/*.ts])
    const githubOverlap = new InMemoryGithub();
    githubOverlap.addIssue(20, { body: buildIssueBody({ scope: 'src/*.ts' }), labels: [...READY_LABELS] });
    githubOverlap.addIssue(10, { body: buildIssueBody({ scope: 'src/a.ts' }), labels: [...READY_LABELS] });

    const reportOverlap = await syncQueueTick({
      github: githubOverlap.port(),
      runId: 'fleet-test',
      dispatchWorker: okWorker,
    });
    assert.deepEqual(reportOverlap.dispatched, [10]);
    assert.deepEqual(reportOverlap.skipped, [
      { issue: 20, reason: 'scope-overlap', blockedBy: [10] },
    ]);

    // Cặp 2: hai ready không giao nhau (10 [src/a.ts] vs 30 [docs/*.md])
    const githubDisjoint = new InMemoryGithub();
    githubDisjoint.addIssue(30, { body: buildIssueBody({ scope: 'docs/*.md' }), labels: [...READY_LABELS] });
    githubDisjoint.addIssue(10, { body: buildIssueBody({ scope: 'src/a.ts' }), labels: [...READY_LABELS] });

    const reportDisjoint = await syncQueueTick({
      github: githubDisjoint.port(),
      runId: 'fleet-test',
      dispatchWorker: okWorker,
    });
    assert.deepEqual(reportDisjoint.dispatched, [10, 30]);
  });

  it('số nhỏ dispatch lỗi → số lớn (giao nhau) vẫn được dispatch (số nhỏ không giữ khoá)', async () => {
    const github = new InMemoryGithub();
    // Issue 10 và 20 có scope giao nhau
    github.addIssue(10, { body: buildIssueBody({ scope: 'src/a.ts' }), labels: [...READY_LABELS] });
    github.addIssue(20, { body: buildIssueBody({ scope: 'src/*.ts' }), labels: [...READY_LABELS] });

    // Giả lập worker thất bại với issue 10 nhưng thành công với issue 20
    const report = await syncQueueTick({
      github: github.port(),
      runId: 'fleet-test',
      dispatchWorker: async (req) => {
        if (req.issueNumber === 10) {
          throw new Error('Worker spawn crash on 10');
        }
        return okWorker(req);
      },
    });

    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.issue, 10);
    // Vì 10 dispatch lỗi nên 10 không giữ khoá -> 20 vẫn được dispatch thành công!
    assert.deepEqual(report.dispatched, [20]);
  });

  it('active có body không parse được → ready bất kỳ bị hoãn blockedBy:[nó], có log', async () => {
    const github = new InMemoryGithub();
    // Active issue có body hỏng / rác
    github.addIssue(50, {
      body: 'Nội dung bậy bạ không theo format issue form',
      labels: ['status:in-progress', 'size:S'],
    });
    // Ready issue với scope cụ thể
    github.addIssue(60, {
      body: buildIssueBody({ scope: 'docs/readme.md' }),
      labels: [...READY_LABELS],
    });

    const logs: string[] = [];
    const report = await syncQueueTick({
      github: github.port(),
      runId: 'fleet-test',
      dispatchWorker: okWorker,
      log: (msg) => logs.push(msg),
    });

    // Ready issue 60 bị chặn bởi issue 50 (do 50 fail-closed gán scope ['**'])
    assert.deepEqual(report.skipped, [
      { issue: 60, reason: 'scope-overlap', blockedBy: [50] },
    ]);
    assert.deepEqual(report.dispatched, []);
    assert.ok(logs.some((l) => l.includes('50') && l.includes('fail-closed')));
  });

  it('listActiveIssues gọi 0 lần khi không issue nào đủ điều kiện, và đúng 1 lần khi có nhiều candidate', async () => {
    let listActiveCalls = 0;

    // Trường hợp 1: Không có issue nào ready
    const emptyGithub = new InMemoryGithub();
    const port1 = {
      ...emptyGithub.port(),
      listActiveIssues: async (limit: number) => {
        listActiveCalls += 1;
        return emptyGithub.port().listActiveIssues(limit);
      },
    };

    await syncQueueTick({
      github: port1,
      runId: 'fleet-test',
      dispatchWorker: okWorker,
    });
    assert.equal(listActiveCalls, 0, 'Không được gọi listActiveIssues nếu không có candidate nào');

    // Trường hợp 2: Có 3 candidate ready đủ điều kiện -> tải lười đúng 1 lần
    listActiveCalls = 0;
    const fullGithub = new InMemoryGithub();
    fullGithub.addIssue(1, { body: buildIssueBody({ scope: 'src/1.ts' }), labels: [...READY_LABELS] });
    fullGithub.addIssue(2, { body: buildIssueBody({ scope: 'src/2.ts' }), labels: [...READY_LABELS] });
    fullGithub.addIssue(3, { body: buildIssueBody({ scope: 'src/3.ts' }), labels: [...READY_LABELS] });

    const port2 = {
      ...fullGithub.port(),
      listActiveIssues: async (limit: number) => {
        listActiveCalls += 1;
        return fullGithub.port().listActiveIssues(limit);
      },
    };

    const report = await syncQueueTick({
      github: port2,
      runId: 'fleet-test',
      dispatchWorker: okWorker,
    });
    assert.equal(listActiveCalls, 1, 'listActiveIssues chỉ được gọi đúng 1 lần (tải lười) trong suốt cả tick');
    assert.deepEqual(report.dispatched, [1, 2, 3]);
  });
});
