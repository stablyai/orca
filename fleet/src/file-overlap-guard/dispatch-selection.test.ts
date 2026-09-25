import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectDispatchable } from './dispatch-selection.ts';

describe('selectDispatchable', () => {
  it('A in-progress [src/a.ts], B [src/*.ts] → B hoãn blockedBy:[A]; A sang review → B dispatch', () => {
    // Khi A đang in-progress: A giữ khoá, B bị hoãn
    const candidateB = { issueNumber: 20, scope: ['src/*.ts'] };
    const activeAInProgress = [{ issueNumber: 10, scope: ['src/a.ts'], status: 'in-progress' }];

    const resultBlocked = selectDispatchable([candidateB], activeAInProgress);
    assert.deepStrictEqual(resultBlocked, {
      dispatch: [],
      deferred: [{ issueNumber: 20, blockedBy: [10] }],
    });

    // Khi A sang review: A nhả khoá, B được dispatch
    const activeAReview = [{ issueNumber: 10, scope: ['src/a.ts'], status: 'review' }];
    const resultDispatched = selectDispatchable([candidateB], activeAReview);
    assert.deepStrictEqual(resultDispatched, {
      dispatch: [20],
      deferred: [],
    });
  });

  it('hai candidate giao nhau cùng lượt → số nhỏ dispatch, số lớn hoãn', () => {
    const candidateSmall = { issueNumber: 15, scope: ['src/util.ts'] };
    const candidateLarge = { issueNumber: 42, scope: ['src/*.ts'] };

    // Truyền không theo thứ tự để đảm bảo hàm tự sắp xếp theo issueNumber tăng dần
    const res = selectDispatchable([candidateLarge, candidateSmall], []);
    assert.deepStrictEqual(res, {
      dispatch: [15],
      deferred: [{ issueNumber: 42, blockedBy: [15] }],
    });
  });

  it('C giao với B (bị hoãn) nhưng không giao với A (đã dispatch) → C vẫn dispatch', () => {
    // A: 10 [src/a.ts]
    // B: 20 [src/*] (giao với A nên B bị hoãn)
    // C: 30 [src/b.ts] (giao với B nhưng KHÔNG giao với A)
    // Vì B bị hoãn nên B KHÔNG giữ khoá; do đó C vẫn được dispatch!
    const candidateA = { issueNumber: 10, scope: ['src/a.ts'] };
    const candidateB = { issueNumber: 20, scope: ['src/*'] };
    const candidateC = { issueNumber: 30, scope: ['src/b.ts'] };

    const res = selectDispatchable([candidateB, candidateC, candidateA], []);
    assert.deepStrictEqual(res, {
      dispatch: [10, 30],
      deferred: [{ issueNumber: 20, blockedBy: [10] }],
    });
  });

  it('B giao với hai task active → blockedBy đủ cả hai', () => {
    const activeTasks = [
      { issueNumber: 101, scope: ['src/core/a.ts'], status: 'in-progress' },
      { issueNumber: 102, scope: ['src/core/b.ts'], status: 'claimed' },
    ];
    const candidateB = { issueNumber: 200, scope: ['src/core/*.ts'] };

    const res = selectDispatchable([candidateB], activeTasks);
    assert.deepStrictEqual(res, {
      dispatch: [],
      deferred: [{ issueNumber: 200, blockedBy: [101, 102] }],
    });
  });

  it('bỏ qua mục active trùng issueNumber với chính candidate', () => {
    // Active task có cùng issueNumber (ví dụ task đang cập nhật scope của chính mình)
    const activeTasks = [{ issueNumber: 50, scope: ['src/foo.ts'], status: 'in-progress' }];
    const candidate = { issueNumber: 50, scope: ['src/foo.ts'] };

    const res = selectDispatchable([candidate], activeTasks);
    assert.deepStrictEqual(res, {
      dispatch: [50],
      deferred: [],
    });
  });

  it('candidate có scope rỗng coi như không giao với ai và được dispatch', () => {
    const activeTasks = [{ issueNumber: 1, scope: ['src/**'], status: 'in-progress' }];
    const candidateEmpty = { issueNumber: 2, scope: [] };

    const res = selectDispatchable([candidateEmpty], activeTasks);
    assert.deepStrictEqual(res, {
      dispatch: [2],
      deferred: [],
    });
  });

  it('tôn trọng danh sách holding tuỳ chỉnh', () => {
    const activeTasks = [{ issueNumber: 1, scope: ['src/**'], status: 'custom-lock' }];
    const candidate = { issueNumber: 2, scope: ['src/a.ts'] };

    // Mặc định không chứa 'custom-lock' -> không giữ khoá
    const resDefault = selectDispatchable([candidate], activeTasks);
    assert.deepStrictEqual(resDefault.dispatch, [2]);

    // Khi truyền holding = ['custom-lock'] -> giữ khoá
    const resCustom = selectDispatchable([candidate], activeTasks, ['custom-lock']);
    assert.deepStrictEqual(resCustom.deferred, [{ issueNumber: 2, blockedBy: [1] }]);
  });

  it('khử trùng lặp và sắp xếp blockedBy tăng dần khi một candidate bị chặn nhiều lần bởi cùng một holder', () => {
    const activeTasks = [
      { issueNumber: 99, scope: ['src/a.ts', 'src/*.ts'], status: 'in-progress' },
      { issueNumber: 12, scope: ['src/a.ts'], status: 'claimed' },
    ];
    const candidate = { issueNumber: 150, scope: ['src/a.ts'] };

    const res = selectDispatchable([candidate], activeTasks);
    assert.deepStrictEqual(res.deferred, [{ issueNumber: 150, blockedBy: [12, 99] }]);
  });
});
