import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createScopeMatcher } from './scope-matcher.ts';

const matches = (patterns: string[], filePath: string): boolean => createScopeMatcher(patterns)(filePath);

describe('createScopeMatcher', () => {
  it('đường dẫn cụ thể chỉ khớp đúng file đó', () => {
    assert.equal(matches(['scripts/pilot-verify.mjs'], 'scripts/pilot-verify.mjs'), true);
    assert.equal(matches(['scripts/pilot-verify.mjs'], 'scripts/pilot-verify.mjs.bak'), false);
    assert.equal(matches(['scripts/pilot-verify.mjs'], 'x/scripts/pilot-verify.mjs'), false);
  });

  it('dấu chấm trong tên là ký tự thường, không phải "bất kỳ ký tự"', () => {
    assert.equal(matches(['a.ts'], 'aXts'), false);
  });

  it('`*` không vượt qua dấu `/`', () => {
    assert.equal(matches(['src/*.ts'], 'src/a.ts'), true);
    assert.equal(matches(['src/*.ts'], 'src/deep/a.ts'), false);
  });

  it('`**` xuyên thư mục và khớp cả khi không có thư mục nào ở giữa', () => {
    assert.equal(matches(['src/**/x.ts'], 'src/x.ts'), true);
    assert.equal(matches(['src/**/x.ts'], 'src/a/b/x.ts'), true);
    assert.equal(matches(['src/**/x.ts'], 'other/x.ts'), false);
    assert.equal(matches(['fleet/src/**'], 'fleet/src/a/b.ts'), true);
  });

  it('`**` đứng cạnh tiền tố không nuốt thư mục anh em (src/** ≠ src-old/…)', () => {
    assert.equal(matches(['src/**'], 'src-old/a.ts'), false);
  });

  it('`dir/` khớp mọi file bên dưới nhưng không khớp thư mục cùng tiền tố', () => {
    assert.equal(matches(['scripts/'], 'scripts/a.mjs'), true);
    assert.equal(matches(['scripts/'], 'scripts/deep/a.mjs'), true);
    assert.equal(matches(['scripts/'], 'scripts-old/a.mjs'), false);
  });

  it('`?` khớp đúng một ký tự, không phải `/`', () => {
    assert.equal(matches(['a?.ts'], 'ab.ts'), true);
    assert.equal(matches(['a?.ts'], 'a/.ts'), false);
  });

  it('`[abc]` và `{a,b}` là ký tự thường — không âm thầm mở rộng phạm vi', () => {
    assert.equal(matches(['src/[ab].ts'], 'src/a.ts'), false);
    assert.equal(matches(['src/[ab].ts'], 'src/[ab].ts'), true);
    assert.equal(matches(['src/{a,b}.ts'], 'src/a.ts'), false);
  });

  it('chuẩn hoá `\\` của Windows ở cả hai phía', () => {
    assert.equal(matches(['src\\tabs\\gen\\Gen.tsx'], 'src/tabs/gen/Gen.tsx'), true);
    assert.equal(matches(['src/tabs/gen/Gen.tsx'], 'src\\tabs\\gen\\Gen.tsx'), true);
  });

  it('phân biệt hoa thường', () => {
    assert.equal(matches(['src/Gen.tsx'], 'src/gen.tsx'), false);
  });

  it('tên file tiếng Việt và khoảng trắng', () => {
    assert.equal(matches(['docs/QUY_TRÌNH/*.md'], 'docs/QUY_TRÌNH/Kịch bản phim.md'), true);
  });

  it('khớp nếu trùng BẤT KỲ mẫu nào; không có mẫu nào → không khớp gì', () => {
    assert.equal(matches(['a.ts', 'b/'], 'b/c.ts'), true);
    assert.equal(matches([], 'a.ts'), false);
  });
});
