import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { READY_LABELS, buildIssueBody } from './agent-task-issue-fixture.ts';
import { InMemoryGithub } from './in-memory-github-port.ts';
import { CLAIM_RACE_WINDOW_MS, claimMarker, parseClaimRunId, tryClaim } from './issue-claim.ts';

function githubWithReadyIssue(): InMemoryGithub {
  const github = new InMemoryGithub();
  github.addIssue(142, { body: buildIssueBody(), labels: [...READY_LABELS] });
  return github;
}

describe('claim marker', () => {
  it('render rồi parse ra đúng runId', () => {
    assert.equal(parseClaimRunId(claimMarker('run-abc_1')), 'run-abc_1');
    assert.equal(parseClaimRunId('không có marker'), undefined);
  });
});

describe('tryClaim', () => {
  it('một Fleet bốc issue ready: thắng, đổi ready → claimed trong một lần gọi', async () => {
    const github = githubWithReadyIssue();
    const outcome = await tryClaim(github.port(), 142, 'fleet-A');
    assert.equal(outcome.won, true);
    assert.deepEqual(github.labelsOf(142).filter((label) => label.startsWith('status:')), ['status:claimed']);
    assert.equal(github.labelChanges.length, 1);
    assert.deepEqual(github.labelChanges[0]?.change, { add: ['status:claimed'], remove: ['status:ready'] });
  });

  it('DoD 2.3: hai Fleet cùng bốc một issue cùng lúc → chỉ MỘT thắng', async () => {
    const github = githubWithReadyIssue();
    const [a, b] = await Promise.all([tryClaim(github.port(), 142, 'fleet-A'), tryClaim(github.port(), 142, 'fleet-B')]);

    const winners = [a, b].filter((outcome) => outcome.won);
    assert.equal(winners.length, 1, 'phải đúng một bên thắng');
    const loser = [a, b].find((outcome) => !outcome.won);
    assert.deepEqual(loser, { won: false, reason: 'lost-race' });
    // Bên thua không đụng nhãn: chỉ có đúng một lần đổi nhãn (của bên thắng).
    assert.equal(github.labelChanges.length, 1);
    assert.deepEqual(github.labelsOf(142).filter((label) => label.startsWith('status:')), ['status:claimed']);
  });

  it('nhiều Fleet (5) cùng bốc → vẫn đúng một thắng', async () => {
    const github = githubWithReadyIssue();
    const outcomes = await Promise.all(['A', 'B', 'C', 'D', 'E'].map((id) => tryClaim(github.port(), 142, `fleet-${id}`)));
    assert.equal(outcomes.filter((outcome) => outcome.won).length, 1);
    assert.equal(github.labelChanges.length, 1);
  });

  it('bên đến sau khi issue đã claimed → not-ready, không đăng thêm comment', async () => {
    const github = githubWithReadyIssue();
    await tryClaim(github.port(), 142, 'fleet-A');
    const commentsBefore = github.commentsOf(142).length;

    const late = await tryClaim(github.port(), 142, 'fleet-B');
    assert.deepEqual(late, { won: false, reason: 'not-ready' });
    assert.equal(github.commentsOf(142).length, commentsBefore);
  });

  it('claim cũ (issue từng được trả về ready) nằm ngoài cửa sổ → không chặn Fleet mới mãi mãi', async () => {
    const github = githubWithReadyIssue();
    await tryClaim(github.port(), 142, 'fleet-old');
    // Người dùng chỉnh spec và gắn lại status:ready sau 1 giờ; comment claim cũ vẫn còn đó.
    github.clockMs += 60 * 60_000;
    const issue = github.issues.get(142);
    assert.ok(issue);
    issue.labels = issue.labels.filter((label) => label !== 'status:claimed').concat('status:ready');

    const outcome = await tryClaim(github.port(), 142, 'fleet-new');
    assert.equal(outcome.won, true);
  });

  it('claim cũ nhưng còn TRONG cửa sổ thì vẫn tranh chấp', async () => {
    const github = githubWithReadyIssue();
    await tryClaim(github.port(), 142, 'fleet-old');
    github.clockMs += CLAIM_RACE_WINDOW_MS - 10_000;
    const issue = github.issues.get(142);
    assert.ok(issue);
    issue.labels = issue.labels.filter((label) => label !== 'status:claimed').concat('status:ready');

    assert.deepEqual(await tryClaim(github.port(), 142, 'fleet-new'), { won: false, reason: 'lost-race' });
  });

  it('lần bốc trước của CHÍNH Fleet này đã đăng claim nhưng đổi nhãn lỗi → lần sau vẫn thắng', async () => {
    const github = githubWithReadyIssue();
    github.failNextLabelChange = true;
    await assert.rejects(tryClaim(github.port(), 142, 'fleet-A'), /từ chối đổi nhãn/);
    assert.deepEqual(github.labelsOf(142).filter((label) => label.startsWith('status:')), ['status:ready']);

    const retry = await tryClaim(github.port(), 142, 'fleet-A');
    assert.equal(retry.won, true);
    assert.deepEqual(github.labelsOf(142).filter((label) => label.startsWith('status:')), ['status:claimed']);
  });

  it('đọc lại chưa thấy comment của chính mình (GitHub trễ) → claim-not-visible, không đổi nhãn', async () => {
    const github = githubWithReadyIssue();
    const port = github.port();
    const laggy = {
      ...port,
      readIssue: async (number: number) => {
        const result = await port.readIssue(number);
        return github.commentsOf(number).length > 0 ? { ...result, comments: [] } : result;
      }
    };
    assert.deepEqual(await tryClaim(laggy, 142, 'fleet-A'), { won: false, reason: 'claim-not-visible' });
    assert.equal(github.labelChanges.length, 0);
  });

  it('issue không có status:ready → not-ready ngay, không comment', async () => {
    const github = new InMemoryGithub();
    github.addIssue(7, { body: buildIssueBody(), labels: ['status:triage', 'size:S'] });
    assert.deepEqual(await tryClaim(github.port(), 7, 'fleet-A'), { won: false, reason: 'not-ready' });
    assert.equal(github.commentsOf(7).length, 0);
  });
});
