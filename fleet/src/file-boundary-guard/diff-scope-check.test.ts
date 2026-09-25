import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateScope } from './diff-scope-check.ts';

describe('evaluateScope', () => {
  it('diff nằm hết trong phạm vi → ok', () => {
    const verdict = evaluateScope({
      patterns: ['scripts/pilot-verify.mjs'],
      committedFiles: ['scripts/pilot-verify.mjs']
    });
    assert.deepEqual(verdict, { status: 'ok', violations: [], warnings: [] });
  });

  it('đụng file ngoài danh sách → blocked + liệt kê file vi phạm (DoD 2.4)', () => {
    const verdict = evaluateScope({
      patterns: ['.github/workflows/ci.yml'],
      committedFiles: ['.github/workflows/ci.yml', 'src/tabs/gen/Gen.tsx', 'package.json']
    });
    assert.equal(verdict.status, 'blocked');
    assert.deepEqual(verdict.violations, ['package.json', 'src/tabs/gen/Gen.tsx']);
  });

  it('diff rỗng không phải vi phạm ranh giới → ok', () => {
    assert.equal(evaluateScope({ patterns: ['a.ts'], committedFiles: [] }).status, 'ok');
  });

  it('đổi tên file ngoài phạm vi vào trong phạm vi vẫn bị bắt (cả đường dẫn cũ)', () => {
    // `--no-renames` biến rename thành xoá `old` + thêm `new`, cả hai đều xuất hiện trong diff.
    const verdict = evaluateScope({
      patterns: ['scripts/'],
      committedFiles: ['src/components/MediaLightbox.tsx', 'scripts/MediaLightbox.tsx']
    });
    assert.equal(verdict.status, 'blocked');
    assert.deepEqual(verdict.violations, ['src/components/MediaLightbox.tsx']);
  });

  it('diff kiểu Windows (`\\`) so được với phạm vi kiểu `/`', () => {
    const verdict = evaluateScope({ patterns: ['src/a.ts'], committedFiles: ['src\\a.ts', 'src\\b.ts'] });
    assert.deepEqual(verdict.violations, ['src/b.ts']);
  });

  it('không lặp và sắp xếp ổn định để comment trên issue không nhảy thứ tự giữa các lần chạy', () => {
    const verdict = evaluateScope({ patterns: ['a.ts'], committedFiles: ['z.ts', 'b.ts', 'z.ts', 'b.ts'] });
    assert.deepEqual(verdict.violations, ['b.ts', 'z.ts']);
  });

  it('file chưa commit ngoài phạm vi (dist/ bị build làm bẩn) chỉ cảnh báo, không chặn', () => {
    const verdict = evaluateScope({
      patterns: ['scripts/pilot-verify.mjs'],
      committedFiles: ['scripts/pilot-verify.mjs'],
      uncommittedFiles: ['dist/index.html', 'dist/assets/index-abc.js', 'scripts/pilot-verify.mjs']
    });
    assert.deepEqual(verdict, {
      status: 'ok',
      violations: [],
      warnings: ['dist/assets/index-abc.js', 'dist/index.html']
    });
  });

  it('file vừa vi phạm (đã commit) vừa còn dở thì chỉ báo ở violations, không lặp ở warnings', () => {
    const verdict = evaluateScope({
      patterns: ['a.ts'],
      committedFiles: ['x.ts'],
      uncommittedFiles: ['x.ts', 'y.ts']
    });
    assert.deepEqual(verdict, { status: 'blocked', violations: ['x.ts'], warnings: ['y.ts'] });
  });

  it('phạm vi rỗng → mọi file đã commit đều vi phạm (không có "cho phép hết" ngầm)', () => {
    assert.equal(evaluateScope({ patterns: [], committedFiles: ['a.ts'] }).status, 'blocked');
  });

  it('tên file tiếng Việt được xử lý đúng', () => {
    const verdict = evaluateScope({ patterns: ['docs/'], committedFiles: ['docs/Kịch bản.md', 'Bản nháp.md'] });
    assert.deepEqual(verdict.violations, ['Bản nháp.md']);
  });
});
