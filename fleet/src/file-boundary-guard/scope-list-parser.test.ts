import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_SCOPE_LINES, parseScopeList } from './scope-list-parser.ts';

describe('parseScopeList', () => {
  it('đọc mỗi dòng một đường dẫn, bỏ dòng trống', () => {
    const result = parseScopeList('src/components/MediaLightbox.tsx\n\nscripts/test-shared.mjs\n');
    assert.deepEqual(result, { ok: true, patterns: ['src/components/MediaLightbox.tsx', 'scripts/test-shared.mjs'] });
  });

  it('chấp nhận gạch đầu dòng, backtick, CRLF và dấu `\\` của Windows', () => {
    const result = parseScopeList('- `src\\tabs\\gen\\Gen.tsx`\r\n* ./scripts/a.mjs\r\n');
    assert.deepEqual(result, { ok: true, patterns: ['src/tabs/gen/Gen.tsx', 'scripts/a.mjs'] });
  });

  it('cho phép glob không ở gốc: src/** và dir/', () => {
    assert.deepEqual(parseScopeList('fleet/src/**\nscripts/'), { ok: true, patterns: ['fleet/src/**', 'scripts/'] });
  });

  it('`*` ở gốc chỉ khớp file cấp gốc nên vẫn được phép', () => {
    assert.equal(parseScopeList('*.md').ok, true);
  });

  it('chặn `**` ở gốc repo (blueprint §4.2)', () => {
    assert.deepEqual(parseScopeList('**'), {
      ok: false,
      problems: [{ code: 'root-double-star', line: 1, text: '**' }]
    });
    const withSuffix = parseScopeList('**/*.ts');
    assert.equal(withSuffix.ok, false);
  });

  it('chặn đường dẫn tuyệt đối (Unix và ổ đĩa Windows)', () => {
    const result = parseScopeList('/etc/passwd\nC:\\Users\\x.txt');
    assert.deepEqual(result, {
      ok: false,
      problems: [
        { code: 'absolute-path', line: 1, text: '/etc/passwd' },
        { code: 'absolute-path', line: 2, text: 'C:/Users/x.txt' }
      ]
    });
  });

  it('chặn `..` chui ra ngoài repo', () => {
    const result = parseScopeList('src/../../secret.txt');
    assert.deepEqual(result, { ok: false, problems: [{ code: 'parent-segment', line: 1, text: 'src/../../secret.txt' }] });
  });

  it('chặn phủ định `!` vì bộ so khớp không hỗ trợ', () => {
    const result = parseScopeList('src/**\n!src/secret.ts');
    assert.deepEqual(result, { ok: false, problems: [{ code: 'negation-unsupported', line: 2, text: '!src/secret.ts' }] });
  });

  it('rỗng hoặc chỉ toàn dòng trống → empty-scope', () => {
    assert.deepEqual(parseScopeList(''), { ok: false, problems: [{ code: 'empty-scope' }] });
    assert.deepEqual(parseScopeList('  \n\n \n'), { ok: false, problems: [{ code: 'empty-scope' }] });
  });

  it(`đúng ${MAX_SCOPE_LINES} dòng thì được, ${MAX_SCOPE_LINES + 1} dòng thì too-many-lines`, () => {
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `a/file-${index}.ts`).join('\n');
    assert.equal(parseScopeList(lines(MAX_SCOPE_LINES)).ok, true);
    assert.deepEqual(parseScopeList(lines(MAX_SCOPE_LINES + 1)), { ok: false, problems: [{ code: 'too-many-lines' }] });
  });

  it('dòng trống không tính vào giới hạn 8 dòng', () => {
    const text = Array.from({ length: MAX_SCOPE_LINES }, (_, index) => `a/${index}.ts\n`).join('\n');
    assert.equal(parseScopeList(text).ok, true);
  });

  it('báo mọi lỗi cùng lúc thay vì dừng ở lỗi đầu tiên', () => {
    const result = parseScopeList('**\n../x\n!y');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        result.problems.map((problem) => problem.code),
        ['root-double-star', 'parent-segment', 'negation-unsupported']
      );
    }
  });
});
