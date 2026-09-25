import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GateReport, GateResult } from './gate-report.ts';
import { MAX_ITERATIONS, dedupeReports, nextAction } from './iteration-guard.ts';

function report(messageId: string, result: GateResult): GateReport {
  return { messageId, result };
}

function reds(count: number): GateReport[] {
  return Array.from({ length: count }, (_, index) => report(`red-${index + 1}`, 'red'));
}

describe('nextAction', () => {
  it('lịch sử rỗng → continue', () => {
    assert.equal(nextAction([]), 'continue');
  });

  it('đỏ dưới ngân sách → continue', () => {
    assert.equal(nextAction(reds(MAX_ITERATIONS - 1)), 'continue');
  });

  it('5 lần đỏ → block (DoD 2.2)', () => {
    assert.equal(nextAction(reds(5)), 'block');
  });

  it('đỏ, đỏ, xanh ở lần 3 → open-pr (DoD 2.2)', () => {
    assert.equal(nextAction([...reds(2), report('green-3', 'green')]), 'open-pr');
  });

  it('xanh ở đúng lần thứ 5 vẫn nằm trong ngân sách → open-pr', () => {
    assert.equal(nextAction([...reds(4), report('green-5', 'green')]), 'open-pr');
  });

  it('xanh ở lần thứ 6 là quá ngân sách → block', () => {
    assert.equal(nextAction([...reds(5), report('green-6', 'green')]), 'block');
  });

  it('xanh rồi lại đỏ → theo báo cáo cuối, tiếp tục nếu còn ngân sách', () => {
    assert.equal(nextAction([report('g', 'green'), report('r', 'red')]), 'continue');
  });

  it('tôn trọng maxIterations tuỳ chỉnh', () => {
    assert.equal(nextAction(reds(2), 2), 'block');
  });

  it('claimedIteration do agent khai không ảnh hưởng số đếm', () => {
    const history: GateReport[] = [{ messageId: 'a', result: 'red', claimedIteration: 99 }];
    assert.equal(nextAction(history), 'continue');
  });
});

describe('dedupeReports', () => {
  it('message replay cùng messageId chỉ đếm một lần', () => {
    const first = report('msg-1', 'red');
    assert.equal(dedupeReports([first, first, first]).length, 1);
    assert.equal(nextAction([first, first, first, first, first]), 'continue');
  });

  it('giữ bản đến trước khi trùng messageId', () => {
    const deduped = dedupeReports([report('m', 'red'), report('m', 'green')]);
    assert.deepEqual(deduped, [report('m', 'red')]);
  });

  it('không sửa mảng đầu vào', () => {
    const input = [report('m', 'red'), report('m', 'red')];
    dedupeReports(input);
    assert.equal(input.length, 2);
  });
});
