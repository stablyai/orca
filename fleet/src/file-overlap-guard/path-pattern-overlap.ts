import { normalizeRepoPath } from '../file-boundary-guard/scope-path.ts';
import { segmentsOverlap } from './segment-glob-overlap.ts';

/**
 * Tách một pattern đường dẫn thành mảng các segment đã chuẩn hoá.
 *
 * Quy tắc:
 * 1. Chuẩn hoá dấu gạch chéo bằng normalizeRepoPath (\ thành /, loại bỏ // và ./ thừa).
 * 2. Hạ toàn bộ chữ thành chữ thường (Windows case-insensitive; false positive chỉ hoãn task, an toàn).
 * 3. Nếu đuôi kết thúc bằng '/' thì thêm '**' (ví dụ 'src/' -> 'src/**').
 * 4. Loại bỏ dấu '/' ở đầu nếu có.
 * 5. Tách theo dấu '/' và lọc bỏ các segment rỗng.
 * 6. Bất kỳ segment nào chứa '**' (dù không đứng riêng một mình, ví dụ 'foo**')
 *    đều được coi như '**' (quy tắc bảo thủ để tránh bỏ sót xung đột).
 */
export function parsePatternSegments(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }

  let normalized = normalizeRepoPath(trimmed).toLowerCase();
  if (normalized.endsWith('/')) {
    normalized = `${normalized}**`;
  }
  while (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  const rawParts = normalized.split('/').filter((seg) => seg.length > 0);
  return rawParts.map((seg) => (seg.includes('**') ? '**' : seg));
}

/**
 * Kiểm tra xem hai pattern đường dẫn có khả năng giao nhau (khớp cùng một file path) hay không.
 *
 * Thuật toán quy hoạch động (DP) có nhớ trạng thái g(i, j):
 * - i: vị trí segment trong danh sách segmentsA (0..N)
 * - j: vị trí segment trong danh sách segmentsB (0..M)
 *
 * Quy tắc chuyển trạng thái:
 * 1. i === N && j === M: cả hai đã duyệt hết -> giao nhau (true).
 * 2. segmentsA[i] === '**':
 *    - '**' khớp 0 segment của B: g(i + 1, j)
 *    - '**' khớp >= 1 segment của B: j < M && g(i, j + 1)
 * 3. segmentsB[j] === '**': đối xứng tương tự segmentsA[i] === '**'.
 * 4. Cả hai là segment thường:
 *    - Gọi segmentsOverlap(segA, segB), nếu khớp thì chuyển sang g(i + 1, j + 1).
 */
export function patternsOverlap(a: string, b: string): boolean {
  const trimmedA = a.trim();
  const trimmedB = b.trim();
  if (trimmedA.length === 0 || trimmedB.length === 0) {
    // Scope rỗng coi như không giao với ai
    return false;
  }

  const segmentsA = parsePatternSegments(trimmedA);
  const segmentsB = parsePatternSegments(trimmedB);

  const n = segmentsA.length;
  const m = segmentsB.length;

  if (n === 0 || m === 0) {
    return false;
  }

  const stride = m + 1;
  const memo = new Int8Array((n + 1) * stride);
  memo.fill(-1);

  function dp(i: number, j: number): boolean {
    const key = i * stride + j;
    const cached = memo[key];
    if (cached !== undefined && cached !== -1) {
      return cached === 1;
    }

    let result = false;

    if (i === n && j === m) {
      // Đã duyệt hết cả hai chuỗi segment
      result = true;
    } else if (i < n && segmentsA[i] === '**') {
      // segmentsA[i] là '**':
      // 1) '**' khớp 0 segment của B: dp(i + 1, j)
      // 2) '**' tiêu thụ ít nhất 1 segment của B: j < m && dp(i, j + 1)
      if (dp(i + 1, j) || (j < m && dp(i, j + 1))) {
        result = true;
      }
    } else if (j < m && segmentsB[j] === '**') {
      // Đối xứng cho segmentsB[j] là '**':
      // 1) '**' khớp 0 segment của A: dp(i, j + 1)
      // 2) '**' tiêu thụ ít nhất 1 segment của A: i < n && dp(i + 1, j)
      if (dp(i, j + 1) || (i < n && dp(i + 1, j))) {
        result = true;
      }
    } else if (i < n && j < m) {
      // Cả hai đều là segment thường (không phải '**')
      const segA = segmentsA[i];
      const segB = segmentsB[j];
      if (segA !== undefined && segB !== undefined && segmentsOverlap(segA, segB)) {
        if (dp(i + 1, j + 1)) {
          result = true;
        }
      }
    }

    memo[key] = result ? 1 : 0;
    return result;
  }

  return dp(0, 0);
}
