import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { READY_LABELS, buildIssueBody } from './agent-task-issue-fixture.ts';
import { TRIAGE_COMMENT_MARKER, assessIssue, formatTriageComment } from './dispatch-eligibility.ts';
import type { EligibilityReason } from './dispatch-eligibility.ts';

function reasonCodes(labels: readonly string[], body = buildIssueBody()): string[] {
  const verdict = assessIssue({ labels, body });
  return verdict.eligible ? [] : verdict.reasons.map((reason) => reason.code);
}

describe('assessIssue', () => {
  it('đủ nhãn và đủ spec → eligible kèm agent và form', () => {
    const verdict = assessIssue({ labels: READY_LABELS, body: buildIssueBody() });
    assert.equal(verdict.eligible, true);
    if (verdict.eligible) {
      assert.equal(verdict.agent, 'claude');
      assert.deepEqual(verdict.form.scopePatterns, ['.github/workflows/ci.yml']);
    }
  });

  it('chấp nhận cả `size:small` (tên nhãn hiện có trên hungdaitool)', () => {
    assert.equal(assessIssue({ labels: ['status:ready', 'size:small', 'agent:codex'], body: buildIssueBody() }).eligible, true);
  });

  it('không ở status:ready → not-ready', () => {
    assert.deepEqual(reasonCodes(['status:triage', 'size:S', 'agent:claude']), ['not-ready']);
  });

  it('size:M / size:L / thiếu size → not-size-s', () => {
    assert.deepEqual(reasonCodes(['status:ready', 'size:M', 'agent:claude']), ['not-size-s']);
    assert.deepEqual(reasonCodes(['status:ready', 'agent:claude']), ['not-size-s']);
  });

  it('thiếu / nhiều nhãn agent', () => {
    assert.deepEqual(reasonCodes(['status:ready', 'size:S']), ['agent-label-missing']);
    assert.deepEqual(reasonCodes(['status:ready', 'size:S', 'agent:claude', 'agent:codex']), ['agent-label-ambiguous']);
  });

  it('agent:antigravity / human / unassigned bị Fleet bỏ qua', () => {
    for (const agent of ['antigravity', 'human', 'unassigned']) {
      assert.deepEqual(reasonCodes(['status:ready', 'size:S', `agent:${agent}`]), ['agent-not-dispatchable'], agent);
    }
  });

  it('gom mọi lý do cùng lúc: nhãn sai và spec thiếu', () => {
    const codes = reasonCodes(['status:ready', 'size:M'], buildIssueBody({ objective: '', dod: 'không lệnh' }));
    assert.deepEqual(codes, ['not-size-s', 'agent-label-missing', 'form-problem', 'form-problem']);
  });
});

describe('formatTriageComment', () => {
  it('có marker, liệt kê từng lý do bằng tiếng Việt và hướng dẫn gắn lại ready', () => {
    const reasons: EligibilityReason[] = [
      { code: 'not-size-s' },
      { code: 'form-problem', problem: { code: 'empty-section', section: 1 } },
      { code: 'form-problem', problem: { code: 'invalid-base-branch', section: 'base-branch' } }
    ];
    const comment = formatTriageComment(reasons);
    assert.ok(comment.startsWith(TRIAGE_COMMENT_MARKER));
    assert.match(comment, /`size:S`/);
    assert.match(comment, /mục 1 \(Mục tiêu đo được\) đang để trống/);
    assert.match(comment, /Nhánh gốc có ký tự không hợp lệ/);
    assert.match(comment, /gắn lại `status:ready`/);
  });
});
