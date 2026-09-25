import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeCpuPercent, toCpuTimes } from './cpu-usage.ts';

describe('toCpuTimes', () => {
  it('cộng dồn thời gian idle và total trên nhiều core CPU', () => {
    const mockCpus = [
      { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
      { times: { user: 200, nice: 10, sys: 40, idle: 750, irq: 0 } }
    ];
    const times = toCpuTimes(mockCpus);
    assert.equal(times.idle, 850 + 750);
    assert.equal(times.total, 1000 + 1000);
  });

  it('danh sách cpus rỗng trả về idle=0 và total=0', () => {
    const times = toCpuTimes([]);
    assert.equal(times.idle, 0);
    assert.equal(times.total, 0);
  });
});

describe('computeCpuPercent', () => {
  it('tính đúng tỷ lệ phần trăm CPU bận rộn giữa 2 mẫu', () => {
    const prev = { idle: 1000, total: 2000 };
    const curr = { idle: 1100, total: 3000 };
    // totalDelta = 1000, idleDelta = 100, usedDelta = 900 -> 90%
    const percent = computeCpuPercent(prev, curr);
    assert.equal(percent, 90);
  });

  it('delta total = 0 trả về 0, không trả về NaN', () => {
    const prev = { idle: 1000, total: 2000 };
    const curr = { idle: 1000, total: 2000 };
    assert.equal(computeCpuPercent(prev, curr), 0);
  });

  it('bộ đếm lùi (prev.total > curr.total) kẹp về 0', () => {
    const prev = { idle: 2000, total: 3000 };
    const curr = { idle: 1000, total: 2000 };
    assert.equal(computeCpuPercent(prev, curr), 0);
  });

  it('idleDelta > totalDelta (bất thường hệ thống) kẹp về 0', () => {
    const prev = { idle: 1000, total: 2000 };
    const curr = { idle: 2500, total: 2100 };
    assert.equal(computeCpuPercent(prev, curr), 0);
  });

  it('CPU hoạt động 100% khi idle không tăng', () => {
    const prev = { idle: 1000, total: 2000 };
    const curr = { idle: 1000, total: 3000 };
    assert.equal(computeCpuPercent(prev, curr), 100);
  });
});
