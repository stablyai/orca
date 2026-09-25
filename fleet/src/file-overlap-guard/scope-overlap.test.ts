import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scopesOverlap } from './scope-overlap.ts';

describe('scopesOverlap', () => {
  it('hai scope hoàn toàn rời nhau trả về overlap: false', () => {
    const res = scopesOverlap(['src/a.ts', 'docs/*.md'], ['src/b.ts', 'tests/*.ts']);
    assert.deepStrictEqual(res, { overlap: false });
  });

  it('hai scope có mẫu giao nhau trả về overlap: true và danh sách xung đột', () => {
    const res = scopesOverlap(['src/a.ts', 'docs/*.md'], ['src/*.ts', 'images/*.png']);
    assert.strictEqual(res.overlap, true);
    if (res.overlap) {
      assert.deepStrictEqual(res.conflicts, [{ a: 'src/a.ts', b: 'src/*.ts' }]);
    }
  });

  it('thu thập toàn bộ các cặp mẫu giao nhau (mọi cặp xung đột)', () => {
    const res = scopesOverlap(['src/a.ts', 'src/b.ts'], ['src/*.ts', 'src/**']);
    assert.strictEqual(res.overlap, true);
    if (res.overlap) {
      assert.strictEqual(res.conflicts.length, 4);
      assert.deepStrictEqual(res.conflicts, [
        { a: 'src/a.ts', b: 'src/*.ts' },
        { a: 'src/a.ts', b: 'src/**' },
        { a: 'src/b.ts', b: 'src/*.ts' },
        { a: 'src/b.ts', b: 'src/**' },
      ]);
    }
  });

  it('xử lý scope rỗng', () => {
    assert.deepStrictEqual(scopesOverlap([], ['src/a.ts']), { overlap: false });
    assert.deepStrictEqual(scopesOverlap(['src/a.ts'], []), { overlap: false });
    assert.deepStrictEqual(scopesOverlap([], []), { overlap: false });
  });
});
