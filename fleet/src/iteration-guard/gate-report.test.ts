import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGateMessage } from './gate-report.ts';

const gatePayload = { fleet: 'gate', iteration: 3, result: 'red', failing: 'npm test: test-shared.mjs' };

describe('parseGateMessage', () => {
  it('đọc payload dạng chuỗi JSON (đúng dạng `orca orchestration check` trả về)', () => {
    const outcome = parseGateMessage({ id: 'msg_1', payload: JSON.stringify(gatePayload) });
    assert.deepEqual(outcome, {
      kind: 'gate',
      report: { messageId: 'msg_1', result: 'red', claimedIteration: 3, failing: 'npm test: test-shared.mjs' }
    });
  });

  it('đọc payload đã là object', () => {
    const outcome = parseGateMessage({ id: 'msg_2', payload: { fleet: 'gate', result: 'green' } });
    assert.deepEqual(outcome, { kind: 'gate', report: { messageId: 'msg_2', result: 'green' } });
  });

  it('bỏ qua worker_done: payload không có fleet=gate', () => {
    const payload = JSON.stringify({ taskId: 't', dispatchId: 'd', outcome: 'succeeded' });
    assert.deepEqual(parseGateMessage({ id: 'msg_3', payload }), { kind: 'ignored', reason: 'not-a-gate-message' });
  });

  it('bỏ qua message không có payload', () => {
    assert.deepEqual(parseGateMessage({ id: 'a' }), { kind: 'ignored', reason: 'no-payload' });
    assert.deepEqual(parseGateMessage({ id: 'b', payload: null }), { kind: 'ignored', reason: 'no-payload' });
    assert.deepEqual(parseGateMessage({ id: 'c', payload: '' }), { kind: 'ignored', reason: 'no-payload' });
  });

  it('JSON hỏng (vd PowerShell 5.1 nuốt dấu ") → ignored, không ném lỗi', () => {
    const outcome = parseGateMessage({ id: 'd', payload: '{fleet:gate,result:red}' });
    assert.deepEqual(outcome, { kind: 'ignored', reason: 'invalid-json' });
  });

  it('payload là mảng hoặc số → invalid-json', () => {
    assert.deepEqual(parseGateMessage({ id: 'e', payload: '[1,2]' }), { kind: 'ignored', reason: 'invalid-json' });
    assert.deepEqual(parseGateMessage({ id: 'f', payload: '42' }), { kind: 'ignored', reason: 'invalid-json' });
  });

  it('result ngoài green/red → invalid-result', () => {
    const payload = JSON.stringify({ fleet: 'gate', result: 'passed' });
    assert.deepEqual(parseGateMessage({ id: 'g', payload }), { kind: 'ignored', reason: 'invalid-result' });
  });

  it('iteration không phải số nguyên bị bỏ, không làm hỏng báo cáo', () => {
    const payload = JSON.stringify({ fleet: 'gate', result: 'red', iteration: '3', failing: 7 });
    assert.deepEqual(parseGateMessage({ id: 'h', payload }), {
      kind: 'gate',
      report: { messageId: 'h', result: 'red' }
    });
  });
});
