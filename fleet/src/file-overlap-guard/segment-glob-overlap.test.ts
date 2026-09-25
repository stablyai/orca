import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { segmentsOverlap } from './segment-glob-overlap.ts';

describe('segmentsOverlap', () => {
  it('khớp chính xác chuỗi ký tự thường', () => {
    assert.strictEqual(segmentsOverlap('file.ts', 'file.ts'), true);
    assert.strictEqual(segmentsOverlap('file.ts', 'file.js'), false);
    assert.strictEqual(segmentsOverlap('abc', 'abcd'), false);
  });

  it('xử lý chuỗi rỗng', () => {
    assert.strictEqual(segmentsOverlap('', ''), true);
    assert.strictEqual(segmentsOverlap('', '*'), true);
    assert.strictEqual(segmentsOverlap('*', ''), true);
    assert.strictEqual(segmentsOverlap('', 'a'), false);
    assert.strictEqual(segmentsOverlap('a', ''), false);
    assert.strictEqual(segmentsOverlap('', '?'), false);
  });

  it('dấu * khớp 0, 1 hoặc nhiều ký tự', () => {
    assert.strictEqual(segmentsOverlap('a*', 'a'), true);
    assert.strictEqual(segmentsOverlap('*', 'anything'), true);
    assert.strictEqual(segmentsOverlap('a*c', 'ac'), true);
    assert.strictEqual(segmentsOverlap('a*c', 'abc'), true);
    assert.strictEqual(segmentsOverlap('a*c', 'abbbbbc'), true);
    assert.strictEqual(segmentsOverlap('a*c', 'ad'), false);
  });

  it('dấu ? khớp đúng 1 ký tự', () => {
    assert.strictEqual(segmentsOverlap('a?', 'ab'), true);
    assert.strictEqual(segmentsOverlap('a?', 'a'), false);
    assert.strictEqual(segmentsOverlap('a?', 'abc'), false);
    assert.strictEqual(segmentsOverlap('??', 'ab'), true);
    assert.strictEqual(segmentsOverlap('??', 'a'), false);
  });

  it('các ca biên bắt buộc theo đặc tả của Claude', () => {
    // a* vs *b -> true (ví dụ 'ab' hoặc 'axb' khớp cả hai)
    assert.strictEqual(segmentsOverlap('a*', '*b'), true);

    // a*b vs c*d -> false (đầu chuỗi 'a' và 'c' xung đột không thể dung hoà)
    assert.strictEqual(segmentsOverlap('a*b', 'c*d'), false);

    // a?.ts vs ab.ts -> true ('?' khớp 'b')
    assert.strictEqual(segmentsOverlap('a?.ts', 'ab.ts'), true);

    // a?.ts vs abc.ts -> false (khác độ dài, '?' chỉ khớp 1 ký tự)
    assert.strictEqual(segmentsOverlap('a?.ts', 'abc.ts'), false);

    // *.ts vs *.tsx -> false (đuôi '.ts' không thể bằng '.tsx' vì 's' != 'x')
    assert.strictEqual(segmentsOverlap('*.ts', '*.tsx'), false);
  });

  it('nhiều dấu * và ? phối hợp phức tạp', () => {
    assert.strictEqual(segmentsOverlap('*a*', '*b*'), true);
    assert.strictEqual(segmentsOverlap('a*b*c', 'axbxc'), true);
    assert.strictEqual(segmentsOverlap('a*b*c', 'axbycz'), false);
    assert.strictEqual(segmentsOverlap('?*?', 'a'), false);
    assert.strictEqual(segmentsOverlap('?*?', 'ab'), true);
    assert.strictEqual(segmentsOverlap('?*?', 'abc'), true);
    assert.strictEqual(segmentsOverlap('*a', '*b'), false);
  });

  it('tính đối xứng với mọi cặp kiểm thử', () => {
    const pairs: [string, string][] = [
      ['file.ts', 'file.ts'],
      ['file.ts', 'file.js'],
      ['a*', '*b'],
      ['a*b', 'c*d'],
      ['a?.ts', 'ab.ts'],
      ['a?.ts', 'abc.ts'],
      ['*.ts', '*.tsx'],
      ['*a*', '*b*'],
      ['a*b*c', 'axbxc'],
      ['', '*'],
      ['a', 'b'],
    ];

    for (const [p, q] of pairs) {
      assert.strictEqual(
        segmentsOverlap(p, q),
        segmentsOverlap(q, p),
        `Không đối xứng trên cặp '${p}' vs '${q}'`,
      );
    }
  });
});
