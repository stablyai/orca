import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SILENCE_LIMIT_MS, DEFAULT_TOTAL_TIMEOUT_MS, checkStall } from './stall-detection.ts';

const START = 1_000_000;

describe('checkStall', () => {
  it('còn trong hạn và có tín hiệu gần đây → chưa kẹt', () => {
    const verdict = checkStall({ now: START + 60_000, startedAt: START, lastSignalAt: START + 50_000 });
    assert.deepEqual(verdict, { stalled: false });
  });

  it('im lặng đủ 10 phút → silence', () => {
    const now = START + DEFAULT_SILENCE_LIMIT_MS + 5_000;
    assert.deepEqual(checkStall({ now, startedAt: START, lastSignalAt: START + 5_000 }), {
      stalled: true,
      reason: 'silence'
    });
  });

  it('im lặng 9 phút 59 giây → chưa kẹt', () => {
    const now = START + DEFAULT_SILENCE_LIMIT_MS - 1;
    assert.equal(checkStall({ now, startedAt: START, lastSignalAt: START }).stalled, false);
  });

  it('chạy đủ 45 phút dù vẫn có tín hiệu → total-timeout', () => {
    const now = START + DEFAULT_TOTAL_TIMEOUT_MS;
    assert.deepEqual(checkStall({ now, startedAt: START, lastSignalAt: now - 1_000 }), {
      stalled: true,
      reason: 'total-timeout'
    });
  });

  it('vừa quá tổng thời gian vừa im lặng → báo total-timeout trước', () => {
    const now = START + DEFAULT_TOTAL_TIMEOUT_MS + 1;
    assert.deepEqual(checkStall({ now, startedAt: START, lastSignalAt: START }), {
      stalled: true,
      reason: 'total-timeout'
    });
  });

  it('nhận giới hạn tuỳ chỉnh', () => {
    const limits = { totalTimeoutMs: 1_000, silenceLimitMs: 500 };
    assert.equal(checkStall({ now: START + 600, startedAt: START, lastSignalAt: START }, limits).stalled, true);
  });
});
