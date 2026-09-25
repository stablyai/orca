import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScopeMatcher } from '../file-boundary-guard/scope-matcher.ts';
import { patternsOverlap } from './path-pattern-overlap.ts';

describe('Property test (Oracle = createScopeMatcher)', () => {
  it('không bao giờ bỏ sót (false negative) khi tồn tại path hợp lệ khớp cả hai pattern', () => {
    // 1. Tập hợp các đường dẫn cụ thể hợp lệ (không segment rỗng, dài <= 6, ký tự {a, b, /}):
    const concretePaths: string[] = [
      'a',
      'b',
      'aa',
      'ab',
      'ba',
      'bb',
      'aaa',
      'aab',
      'aba',
      'abb',
      'baa',
      'bab',
      'bba',
      'bbb',
      'a/a',
      'a/b',
      'b/a',
      'b/b',
      'a/aa',
      'a/ab',
      'a/ba',
      'a/bb',
      'aa/a',
      'ab/a',
      'ba/a',
      'bb/a',
      'aa/bb',
      'ab/ba',
      'a/a/a',
      'a/a/b',
      'a/b/a',
      'a/b/b',
      'b/a/a',
      'b/a/b',
      'b/b/a',
      'b/b/b',
      'a/a/aa',
      'a/aa/a',
      'aa/a/a',
      'a/b/ab',
      'ab/a/b',
      'a/a/a/a',
      'a/a/a/b',
      'b/b/b/b',
    ];

    // 2. Tập hợp các pattern sinh từ {a, b, *, ?, /} (độ dài <= 5, có cả ** và dir/):
    const candidatePatterns: string[] = [
      '*',
      '**',
      '?',
      'a',
      'b',
      'a*',
      '*a',
      '*b',
      'b*',
      'a?',
      '?a',
      'b?',
      '?b',
      'a*b',
      'b*a',
      'a?b',
      '*a*',
      '*b*',
      '**a',
      'a**',
      'a/',
      'b/',
      'a/b/',
      'a/*',
      '*/*',
      '*/a',
      'a/b',
      'b/a',
      'a/**',
      '**/b',
      'a/**/b',
      '**/*',
      '*/**',
      'a/?',
      '?/b',
      '?/?',
      'a/b/*',
      'a/*/b',
      '*/a/b',
      'a/b/a',
      '*a/*',
      'a*/*b',
      'a*/**',
      '**/a*',
      'a/a/a',
      'a/a/b',
    ];

    // 3. Với mỗi pattern, dùng createScopeMatcher (oracle) để tìm tập các path khớp nó
    const patternMatches = new Map<string, Set<string>>();
    for (const pat of candidatePatterns) {
      const matcher = createScopeMatcher([pat]);
      const matched = new Set<string>();
      for (const p of concretePaths) {
        if (matcher(p)) {
          matched.add(p);
        }
      }
      patternMatches.set(pat, matched);
    }

    // 4. Kiểm tra mọi cặp pattern (p1, p2):
    // Nếu tồn tại ít nhất 1 path mà matcher(p1) và matcher(p2) đều trả về true,
    // thì patternsOverlap(p1, p2) BẮT BUỘC PHẢI TRẢ VỀ TRUE. Bỏ sót là vi phạm nghiêm trọng!
    let verifiedIntersections = 0;

    for (let i = 0; i < candidatePatterns.length; i += 1) {
      const p1 = candidatePatterns[i]!;
      const set1 = patternMatches.get(p1)!;

      for (let j = i; j < candidatePatterns.length; j += 1) {
        const p2 = candidatePatterns[j]!;
        const set2 = patternMatches.get(p2)!;

        // Tìm xem có path nào chung giữa set1 và set2 không:
        let commonPath: string | undefined;
        for (const path of set1) {
          if (set2.has(path)) {
            commonPath = path;
            break;
          }
        }

        if (commonPath !== undefined) {
          // Tồn tại nhân chứng (commonPath) chứng minh p1 và p2 giao nhau!
          const result = patternsOverlap(p1, p2);
          assert.strictEqual(
            result,
            true,
            `LỖI BỎ SÓT (False Negative): patternsOverlap('${p1}', '${p2}') trả về false, nhưng path '${commonPath}' khớp cả hai theo createScopeMatcher!`,
          );
          verifiedIntersections += 1;
        }
      }
    }

    // Đảm bảo có một lượng lớn cặp giao nhau thực tế được kiểm chứng
    assert.ok(
      verifiedIntersections >= 100,
      `Kỳ vọng ít nhất 100 cặp giao nhau được kiểm chứng, thực tế: ${verifiedIntersections}`,
    );
  });
});
