import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_LIMITS,
  evaluateResources,
  formatDeferReason,
  type DeferReason
} from './resource-guard.ts';
import type { ResourceSample } from './resource-history.ts';

describe('evaluateResources', () => {
  const NOW = 1_000_000;
  const GIB = 1024 ** 3;

  it('lịch sử rỗng → trả về no-samples (fail-closed)', () => {
    const verdict = evaluateResources([], NOW);
    assert.deepEqual(verdict, {
      dispatch: false,
      reasons: [{ type: 'no-samples' }]
    });
  });

  it('RAM đúng 4 GiB và CPU bình thường → cho qua (dispatch: true)', () => {
    const history: ResourceSample[] = [
      { at: NOW - 120_000, freeMemBytes: 4 * GIB, cpuPercent: 50 },
      { at: NOW, freeMemBytes: 4 * GIB, cpuPercent: 50 }
    ];
    const verdict = evaluateResources(history, NOW);
    assert.deepEqual(verdict, { dispatch: true });
  });

  it('RAM 4 GiB - 1 byte → hoãn với low-memory', () => {
    const history: ResourceSample[] = [
      { at: NOW, freeMemBytes: 4 * GIB - 1, cpuPercent: 50 }
    ];
    const verdict = evaluateResources(history, NOW);
    assert.deepEqual(verdict, {
      dispatch: false,
      reasons: [
        {
          type: 'low-memory',
          freeMemBytes: 4 * GIB - 1,
          minFreeMemBytes: 4 * GIB
        }
      ]
    });
  });

  it('CPU đúng 85% suốt cửa sổ 2 phút → cho qua (không tính là cao)', () => {
    const history: ResourceSample[] = [
      { at: NOW - 120_000, freeMemBytes: 8 * GIB, cpuPercent: 85 },
      { at: NOW - 60_000, freeMemBytes: 8 * GIB, cpuPercent: 85 },
      { at: NOW, freeMemBytes: 8 * GIB, cpuPercent: 85 }
    ];
    const verdict = evaluateResources(history, NOW);
    assert.deepEqual(verdict, { dispatch: true });
  });

  it('CPU 86% suốt 2 phút nhưng một mẫu giữa = 85% → cho qua', () => {
    const history: ResourceSample[] = [
      { at: NOW - 120_000, freeMemBytes: 8 * GIB, cpuPercent: 86 },
      { at: NOW - 60_000, freeMemBytes: 8 * GIB, cpuPercent: 85 }, // Không vượt ngưỡng
      { at: NOW, freeMemBytes: 8 * GIB, cpuPercent: 86 }
    ];
    const verdict = evaluateResources(history, NOW);
    assert.deepEqual(verdict, { dispatch: true });
  });

  it('mẫu phủ đúng tại now - 120000 và toàn bộ CPU > 85% → hoãn với high-cpu', () => {
    const history: ResourceSample[] = [
      { at: NOW - 120_000, freeMemBytes: 8 * GIB, cpuPercent: 86 },
      { at: NOW - 60_000, freeMemBytes: 8 * GIB, cpuPercent: 90 },
      { at: NOW, freeMemBytes: 8 * GIB, cpuPercent: 88 }
    ];
    const verdict = evaluateResources(history, NOW);
    assert.deepEqual(verdict, {
      dispatch: false,
      reasons: [
        {
          type: 'high-cpu',
          windowMs: 120_000,
          lowestCpuPercent: 86
        }
      ]
    });
  });

  it('mới có 90s dữ liệu CPU 99% (chưa đủ 2 phút) → cho qua (fail-open)', () => {
    const history: ResourceSample[] = [
      { at: NOW - 90_000, freeMemBytes: 8 * GIB, cpuPercent: 99 },
      { at: NOW, freeMemBytes: 8 * GIB, cpuPercent: 99 }
    ];
    const verdict = evaluateResources(history, NOW);
    assert.deepEqual(verdict, { dispatch: true });
  });

  it('mẫu CPU trong cửa sổ bị undefined → cho qua (chưa đủ bằng chứng)', () => {
    const history: ResourceSample[] = [
      { at: NOW - 120_000, freeMemBytes: 8 * GIB, cpuPercent: undefined },
      { at: NOW, freeMemBytes: 8 * GIB, cpuPercent: 90 }
    ];
    const verdict = evaluateResources(history, NOW);
    assert.deepEqual(verdict, { dispatch: true });
  });

  it('vừa RAM thấp vừa CPU cao cùng lúc → trả về cả 2 reasons', () => {
    const history: ResourceSample[] = [
      { at: NOW - 120_000, freeMemBytes: 2 * GIB, cpuPercent: 90 },
      { at: NOW, freeMemBytes: 3 * GIB, cpuPercent: 92 }
    ];
    const verdict = evaluateResources(history, NOW);
    assert.deepEqual(verdict, {
      dispatch: false,
      reasons: [
        {
          type: 'low-memory',
          freeMemBytes: 3 * GIB,
          minFreeMemBytes: 4 * GIB
        },
        {
          type: 'high-cpu',
          windowMs: 120_000,
          lowestCpuPercent: 90
        }
      ]
    });
  });
});

describe('formatDeferReason', () => {
  it('định dạng lý do no-samples tiếng Việt', () => {
    const str = formatDeferReason({ type: 'no-samples' });
    assert.equal(str, 'Hoãn dispatch: Chưa có mẫu đo tài nguyên hệ thống.');
  });

  it('định dạng lý do low-memory tiếng Việt', () => {
    const reason: DeferReason = {
      type: 'low-memory',
      freeMemBytes: 3.2 * 1024 ** 3,
      minFreeMemBytes: 4 * 1024 ** 3
    };
    const str = formatDeferReason(reason);
    assert.equal(str, 'Hoãn dispatch: RAM trống 3.2 GiB < 4 GiB.');
  });

  it('định dạng lý do high-cpu tiếng Việt', () => {
    const reason: DeferReason = {
      type: 'high-cpu',
      windowMs: 120_000,
      lowestCpuPercent: 88.5
    };
    const str = formatDeferReason(reason);
    assert.equal(str, 'Hoãn dispatch: CPU duy trì cao liên tục trong 2 phút (thấp nhất 88.5%).');
  });
});
