import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addSample, type ResourceSample } from './resource-history.ts';

describe('addSample', () => {
  it('thêm mẫu vào lịch sử rỗng và không làm biến đổi mảng gốc', () => {
    const original: readonly ResourceSample[] = [];
    const sample: ResourceSample = { at: 1000, freeMemBytes: 8 * 1024 ** 3, cpuPercent: 20 };
    const res = addSample(original, sample, 60_000);

    assert.equal(original.length, 0);
    assert.deepEqual(res, [sample]);
  });

  it('bỏ qua mẫu nếu thời gian bị lùi (s.at < mẫu cuối) mà không ném lỗi', () => {
    const history: ResourceSample[] = [
      { at: 5000, freeMemBytes: 8 * 1024 ** 3 },
      { at: 6000, freeMemBytes: 8 * 1024 ** 3 }
    ];
    const backwardSample: ResourceSample = { at: 4000, freeMemBytes: 8 * 1024 ** 3 };
    const res = addSample(history, backwardSample, 60_000);

    assert.deepEqual(res, history);
    assert.notEqual(res, history); // Mảng mới bất biến
  });

  it('cắt các mẫu quá cũ nhưng giữ lại đúng 1 mẫu phủ mới nhất có at <= s.at - windowMs', () => {
    // windowMs = 100
    // Các mẫu cũ:
    // at: 10 (cũ hơn, cần bỏ)
    // at: 50 (cũ hơn, cần bỏ)
    // at: 100 (mẫu mới nhất có at <= 200 - 100 = 100 -> giữ lại làm mốc phủ)
    // at: 150 (trong cửa sổ -> giữ)
    const history: ResourceSample[] = [
      { at: 10, freeMemBytes: 8 * 1024 ** 3 },
      { at: 50, freeMemBytes: 8 * 1024 ** 3 },
      { at: 100, freeMemBytes: 8 * 1024 ** 3 },
      { at: 150, freeMemBytes: 8 * 1024 ** 3 }
    ];
    const newSample: ResourceSample = { at: 200, freeMemBytes: 8 * 1024 ** 3 };
    const res = addSample(history, newSample, 100);

    assert.equal(res.length, 3);
    assert.equal(res[0]?.at, 100); // Mẫu phủ mốc biên
    assert.equal(res[1]?.at, 150);
    assert.equal(res[2]?.at, 200);
  });

  it('giữ lại toàn bộ nếu chưa có mẫu nào chạm ngưỡng cửa sổ', () => {
    const history: ResourceSample[] = [
      { at: 150, freeMemBytes: 8 * 1024 ** 3 }
    ];
    const newSample: ResourceSample = { at: 200, freeMemBytes: 8 * 1024 ** 3 };
    const res = addSample(history, newSample, 100); // threshold = 100, at: 150 > 100

    assert.equal(res.length, 2);
    assert.equal(res[0]?.at, 150);
    assert.equal(res[1]?.at, 200);
  });
});
