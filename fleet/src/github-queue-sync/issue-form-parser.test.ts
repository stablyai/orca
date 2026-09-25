import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildIssueBody } from './agent-task-issue-fixture.ts';
import { DEFAULT_PLACEHOLDERS, parseAgentTaskForm } from './issue-form-parser.ts';
import type { FormProblem } from './issue-form-parser.ts';

function problemsOf(body: string): FormProblem[] {
  const result = parseAgentTaskForm(body);
  assert.equal(result.ok, false);
  return result.ok ? [] : [...result.problems];
}

describe('parseAgentTaskForm', () => {
  it('đọc đủ 4 ô bắt buộc và ô phụ từ body GitHub Issue Form', () => {
    const result = parseAgentTaskForm(buildIssueBody({ context: 'Issue cha #12' }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.form.objective, 'Sau khi merge, CI chạy pilot-verify cho SKILL.md và log có dòng ✓.');
      assert.deepEqual(result.form.scopePatterns, ['.github/workflows/ci.yml']);
      assert.match(result.form.definitionOfDone, /npm test/);
      assert.match(result.form.negativeConstraints, /Không chạy lệnh xoá/);
      assert.equal(result.form.proposedAgent, 'claude');
      assert.equal(result.form.baseBranch, 'main');
      assert.equal(result.form.context, 'Issue cha #12');
    }
  });

  it('body CRLF (gõ trên Windows) cũng đọc được', () => {
    assert.equal(parseAgentTaskForm(buildIssueBody().replaceAll('\n', '\r\n')).ok, true);
  });

  it('ô phụ để trống (`_No response_`) → không có context; nhánh gốc mặc định main', () => {
    const result = parseAgentTaskForm(buildIssueBody({ baseBranch: '' }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.form.context, undefined);
      assert.equal(result.form.baseBranch, 'main');
    }
  });

  it('thiếu hẳn một ô → missing-section kèm số mục', () => {
    assert.deepEqual(problemsOf(buildIssueBody({ dod: null })), [{ code: 'missing-section', section: 3 }]);
  });

  it('ô để trống → empty-section', () => {
    assert.deepEqual(problemsOf(buildIssueBody({ objective: '' })), [{ code: 'empty-section', section: 1 }]);
  });

  it('còn nguyên nội dung mẫu → placeholder-only, cho từng mục', () => {
    for (const [number, key] of [[1, 'objective'], [2, 'scope'], [3, 'dod'], [4, 'constraints']] as const) {
      const problems = problemsOf(buildIssueBody({ [key]: DEFAULT_PLACEHOLDERS[number] }));
      assert.ok(problems.some((problem) => problem.code === 'placeholder-only' && problem.section === number), `mục ${number}`);
    }
  });

  it('nội dung thật có nhắc tới cùng file với mẫu (MediaLightbox) không bị coi là placeholder', () => {
    assert.equal(parseAgentTaskForm(buildIssueBody({ scope: 'src/components/MediaLightbox.tsx' })).ok, true);
  });

  it('phạm vi không hợp lệ → invalid-scope kèm lý do chi tiết', () => {
    const [problem] = problemsOf(buildIssueBody({ scope: '**' }));
    assert.equal(problem?.code, 'invalid-scope');
    assert.deepEqual(problem?.scopeProblems?.map((scopeProblem) => scopeProblem.code), ['root-double-star']);
  });

  it('DoD không có lệnh trong backtick → dod-has-no-command', () => {
    assert.deepEqual(problemsOf(buildIssueBody({ dod: '- [ ] chạy hết test cho tôi' })), [{ code: 'dod-has-no-command', section: 3 }]);
  });

  it('nhánh gốc bắt đầu bằng `-` hoặc chứa `..` bị chặn (chống chèn tuỳ chọn git)', () => {
    assert.deepEqual(problemsOf(buildIssueBody({ baseBranch: '--output=x' })), [{ code: 'invalid-base-branch', section: 'base-branch' }]);
    assert.deepEqual(problemsOf(buildIssueBody({ baseBranch: 'a..b' })), [{ code: 'invalid-base-branch', section: 'base-branch' }]);
    assert.equal(parseAgentTaskForm(buildIssueBody({ baseBranch: 'release/1.2' })).ok, true);
  });

  it('báo mọi lỗi cùng lúc', () => {
    const problems = problemsOf(buildIssueBody({ objective: '', scope: null, dod: 'không lệnh' }));
    assert.deepEqual(problems.map((problem) => problem.code), ['empty-section', 'missing-section', 'dod-has-no-command']);
  });

  it('body rỗng → thiếu cả 4 ô', () => {
    assert.equal(problemsOf('').filter((problem) => problem.code === 'missing-section').length, 4);
  });

  it('cho phép truyền placeholder riêng khi template đổi', () => {
    const custom = { ...DEFAULT_PLACEHOLDERS, 1: 'Mẫu mới' };
    const result = parseAgentTaskForm(buildIssueBody({ objective: 'Mẫu mới' }), custom);
    assert.equal(result.ok, false);
  });
});
