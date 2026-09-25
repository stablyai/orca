import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createResourceGuard,
  nodeSystemProbe,
  type SystemProbe
} from './system-probe.ts';

describe('createResourceGuard', () => {
  it('mẫu đầu tiên có cpuPercent là undefined, mẫu thứ 2 tính được CPU', () => {
    let currentTime = 1_000_000;
    let cpuTick = 1000;

    const mockProbe: SystemProbe = {
      now: () => currentTime,
      freemem: () => 8 * 1024 ** 3,
      cpus: () => [
        {
          times: {
            user: cpuTick,
            nice: 0,
            sys: 0,
            idle: 10_000,
            irq: 0
          }
        }
      ]
    };

    const guard = createResourceGuard({ probe: mockProbe });

    // Lấy mẫu 1
    guard.sample();
    const history1 = guard.getHistory();
    assert.equal(history1.length, 1);
    assert.equal(history1[0]?.cpuPercent, undefined);

    // Tiến thời gian và tăng CPU
    currentTime += 60_000;
    cpuTick += 5000; // user tăng 5000, idle giữ nguyên -> CPU cao
    guard.sample();

    const history2 = guard.getHistory();
    assert.equal(history2.length, 2);
    assert.equal(typeof history2[1]?.cpuPercent, 'number');
    assert.equal((history2[1]?.cpuPercent ?? 0) > 0, true);
  });

  it('tự động phản hồi check() theo kết quả các lần sample', () => {
    let currentTime = 1_000_000;
    let freeMem = 2 * 1024 ** 3; // RAM thấp: 2 GiB < 4 GiB

    const mockProbe: SystemProbe = {
      now: () => currentTime,
      freemem: () => freeMem,
      cpus: () => [{ times: { user: 100, idle: 900 } }]
    };

    const guard = createResourceGuard({ probe: mockProbe });

    // Chưa sample -> check ra no-samples
    assert.deepEqual(guard.check(), {
      dispatch: false,
      reasons: [{ type: 'no-samples' }]
    });

    // Sau khi sample RAM thấp -> check ra low-memory
    guard.sample();
    const verdict = guard.check();
    assert.equal(verdict.dispatch, false);
    if (!verdict.dispatch) {
      assert.equal(verdict.reasons[0]?.type, 'low-memory');
    }
  });

  it('nodeSystemProbe trả về các thông số môi trường hệ điều hành hợp lệ', () => {
    assert.equal(typeof nodeSystemProbe.now(), 'number');
    assert.equal(typeof nodeSystemProbe.freemem(), 'number');
    assert.equal(nodeSystemProbe.freemem() > 0, true);
    const cpus = nodeSystemProbe.cpus();
    assert.equal(Array.isArray(cpus), true);
    assert.equal(cpus.length > 0, true);
  });
});
