import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePatternSegments, patternsOverlap } from './path-pattern-overlap.ts';

describe('parsePatternSegments', () => {
  it('tách và chuẩn hoá đường dẫn thông thường', () => {
    assert.deepStrictEqual(parsePatternSegments('src/a.ts'), ['src', 'a.ts']);
    assert.deepStrictEqual(parsePatternSegments('Src/A.ts'), ['src', 'a.ts']);
    assert.deepStrictEqual(parsePatternSegments('src\\a.ts'), ['src', 'a.ts']);
  });

  it('đuôi / tự động thêm segment **', () => {
    assert.deepStrictEqual(parsePatternSegments('src/'), ['src', '**']);
    assert.deepStrictEqual(parsePatternSegments('/'), ['**']);
  });

  it('segment chứa ** dù không đứng riêng coi như ** (bảo thủ)', () => {
    assert.deepStrictEqual(parsePatternSegments('foo**'), ['**']);
    assert.deepStrictEqual(parsePatternSegments('src/foo**bar/baz.ts'), ['src', '**', 'baz.ts']);
  });

  it('xử lý chuỗi rỗng và khoảng trắng', () => {
    assert.deepStrictEqual(parsePatternSegments(''), []);
    assert.deepStrictEqual(parsePatternSegments('   '), []);
  });
});

describe('patternsOverlap', () => {
  it('bảng ca biên bắt buộc theo đặc tả của Claude', () => {
    // 1. src/a.ts vs src/a.ts → true; vs src/b.ts → false
    assert.strictEqual(patternsOverlap('src/a.ts', 'src/a.ts'), true);
    assert.strictEqual(patternsOverlap('src/a.ts', 'src/b.ts'), false);

    // 2. src/ vs src/deep/x.ts → true; src/*.ts vs src/deep/a.ts → false
    assert.strictEqual(patternsOverlap('src/', 'src/deep/x.ts'), true);
    assert.strictEqual(patternsOverlap('src/*.ts', 'src/deep/a.ts'), false);

    // 3. src/**/x.ts vs src/x.ts → true (** khớp 0 segment); src/** vs src-old/a.ts → false
    assert.strictEqual(patternsOverlap('src/**/x.ts', 'src/x.ts'), true);
    assert.strictEqual(patternsOverlap('src/**', 'src-old/a.ts'), false);

    // 4. *.md vs README.md → true; *.md vs docs/a.md → false
    assert.strictEqual(patternsOverlap('*.md', 'README.md'), true);
    assert.strictEqual(patternsOverlap('*.md', 'docs/a.md'), false);

    // 5. a?.ts vs ab.ts → true; a?.ts vs abc.ts → false
    assert.strictEqual(patternsOverlap('a?.ts', 'ab.ts'), true);
    assert.strictEqual(patternsOverlap('a?.ts', 'abc.ts'), false);

    // 6. *.ts vs *.tsx → false; a* vs *b → true; a*b vs c*d → false
    assert.strictEqual(patternsOverlap('*.ts', '*.tsx'), false);
    assert.strictEqual(patternsOverlap('a*', '*b'), true);
    assert.strictEqual(patternsOverlap('a*b', 'c*d'), false);

    // 7. Src/A.ts vs src/a.ts → true; src\a.ts vs src/a.ts → true; foo** vs bar/x → true (bảo thủ)
    assert.strictEqual(patternsOverlap('Src/A.ts', 'src/a.ts'), true);
    assert.strictEqual(patternsOverlap('src\\a.ts', 'src/a.ts'), true);
    assert.strictEqual(patternsOverlap('foo**', 'bar/x'), true);
  });

  it('tính đối xứng với mọi cặp trong bảng đặc tả của Claude', () => {
    const tablePairs: [string, string, boolean][] = [
      ['src/a.ts', 'src/a.ts', true],
      ['src/a.ts', 'src/b.ts', false],
      ['src/', 'src/deep/x.ts', true],
      ['src/*.ts', 'src/deep/a.ts', false],
      ['src/**/x.ts', 'src/x.ts', true],
      ['src/**', 'src-old/a.ts', false],
      ['*.md', 'README.md', true],
      ['*.md', 'docs/a.md', false],
      ['a?.ts', 'ab.ts', true],
      ['a?.ts', 'abc.ts', false],
      ['*.ts', '*.tsx', false],
      ['a*', '*b', true],
      ['a*b', 'c*d', false],
      ['Src/A.ts', 'src/a.ts', true],
      ['src\\a.ts', 'src/a.ts', true],
      ['foo**', 'bar/x', true],
    ];

    for (const [a, b, expected] of tablePairs) {
      assert.strictEqual(patternsOverlap(a, b), expected, `Thất bại: patternsOverlap('${a}', '${b}')`);
      assert.strictEqual(
        patternsOverlap(b, a),
        expected,
        `Mất đối xứng: patternsOverlap('${b}', '${a}')`,
      );
    }
  });

  it('xử lý chuỗi rỗng và scope rỗng', () => {
    assert.strictEqual(patternsOverlap('', 'src/a.ts'), false);
    assert.strictEqual(patternsOverlap('src/a.ts', ''), false);
    assert.strictEqual(patternsOverlap('', ''), false);
    assert.strictEqual(patternsOverlap('   ', 'src/a.ts'), false);
  });

  it('** đứng ở các vị trí khác nhau trong đường dẫn', () => {
    assert.strictEqual(patternsOverlap('**', 'any/path/file.txt'), true);
    assert.strictEqual(patternsOverlap('**/test/**', 'a/b/test/c/d'), true);
    assert.strictEqual(patternsOverlap('**/test/**', 'a/b/other/c/d'), false);
    assert.strictEqual(patternsOverlap('src/**/test.ts', 'src/a/b/c/test.ts'), true);
    assert.strictEqual(patternsOverlap('src/**/test.ts', 'src/test.ts'), true);
  });
});
