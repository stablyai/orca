import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canTransition, planTransition, readStatus, statusLabel } from './label-state-machine.ts';

describe('readStatus', () => {
  it('không có label status:* → none; nhãn khác không ảnh hưởng', () => {
    assert.deepEqual(readStatus(['size:S', 'agent:claude']), { kind: 'none' });
  });

  it('đúng một label → one', () => {
    assert.deepEqual(readStatus(['size:S', 'status:ready']), { kind: 'one', status: 'ready' });
  });

  it('hai label status:* → conflict (vi phạm bất biến "chỉ một status")', () => {
    assert.deepEqual(readStatus(['status:ready', 'status:blocked']), { kind: 'conflict', statuses: ['ready', 'blocked'] });
  });

  it('bỏ qua status lạ như status:backlog / status:done chưa thuộc máy trạng thái', () => {
    assert.deepEqual(readStatus(['status:backlog', 'status:done']), { kind: 'none' });
  });

  it('cùng một label lặp lại không tính là xung đột', () => {
    assert.deepEqual(readStatus(['status:ready', 'status:ready']), { kind: 'one', status: 'ready' });
  });
});

describe('canTransition (blueprint §2.2)', () => {
  const legal: [Parameters<typeof canTransition>[0], Parameters<typeof canTransition>[1]][] = [
    ['triage', 'ready'],
    ['ready', 'claimed'],
    ['ready', 'triage'],
    ['claimed', 'in-progress'],
    ['claimed', 'ready'],
    ['claimed', 'blocked'],
    ['in-progress', 'review'],
    ['in-progress', 'blocked'],
    ['review', 'in-progress'],
    ['review', 'done'],
    ['blocked', 'ready']
  ];
  for (const [from, to] of legal) {
    it(`${from} → ${to} hợp lệ`, () => assert.equal(canTransition(from, to), true));
  }

  it('không nhảy cóc: ready → in-progress, triage → claimed, blocked → in-progress', () => {
    assert.equal(canTransition('ready', 'in-progress'), false);
    assert.equal(canTransition('triage', 'claimed'), false);
    assert.equal(canTransition('blocked', 'in-progress'), false);
  });

  it('done là trạng thái cuối', () => {
    assert.equal(canTransition('done', 'ready'), false);
  });
});

describe('planTransition', () => {
  it('ready → claimed: thêm nhãn mới và gỡ nhãn cũ trong CÙNG một kế hoạch', () => {
    assert.deepEqual(planTransition(['status:ready', 'size:S'], 'claimed'), {
      ok: true,
      addLabels: ['status:claimed'],
      removeLabels: ['status:ready']
    });
  });

  it('đã ở đúng trạng thái đích → kế hoạch rỗng, không tốn lượt gọi API', () => {
    assert.deepEqual(planTransition(['status:in-progress'], 'in-progress'), { ok: true, addLabels: [], removeLabels: [] });
  });

  it('review → done chỉ gỡ status:review (issue được đóng bởi Closes #n, không có nhãn done)', () => {
    assert.deepEqual(planTransition(['status:review'], 'done'), { ok: true, addLabels: [], removeLabels: ['status:review'] });
  });

  it('cạnh không hợp lệ → illegal-transition', () => {
    assert.deepEqual(planTransition(['status:ready'], 'review'), { ok: false, reason: 'illegal-transition' });
  });

  it('không có status → no-status; nhiều status → conflicting-status (không tự đoán)', () => {
    assert.deepEqual(planTransition(['size:S'], 'ready'), { ok: false, reason: 'no-status' });
    assert.deepEqual(planTransition(['status:ready', 'status:review'], 'claimed'), { ok: false, reason: 'conflicting-status' });
  });

  it('statusLabel khớp tên nhãn trên GitHub', () => {
    assert.equal(statusLabel('in-progress'), 'status:in-progress');
  });
});
