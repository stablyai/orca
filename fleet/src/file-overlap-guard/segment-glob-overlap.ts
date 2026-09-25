/**
 * Kiểm tra xem hai segment đường dẫn (không chứa `/`) có tồn tại chuỗi con
 * cụ thể nào khớp với cả hai pattern hay không.
 * Chỉ hỗ trợ ký tự thường, `*` (khớp >= 0 ký tự) và `?` (khớp đúng 1 ký tự).
 *
 * Thuật toán quy hoạch động (DP) có nhớ trạng thái (i, j):
 * - i: vị trí con trỏ trong pattern p (0..n)
 * - j: vị trí con trỏ trong pattern q (0..m)
 *
 * Nguyên tắc:
 * 1. Khi i === n && j === m: cả hai đều duyệt xong chuỗi -> khớp thành công (true).
 * 2. Khi p[i] === '*':
 *    - Hoặc '*' khớp 0 ký tự: dp(i + 1, j)
 *    - Hoặc '*' khớp 1 hoặc nhiều ký tự của q: nếu j < m thì dp(i, j + 1)
 * 3. Khi q[j] === '*': đối xứng tương tự p[i] === '*'.
 * 4. Khi cả hai là ký tự thường hoặc '?':
 *    - Khớp khi p[i] === '?' || q[j] === '?' || p[i] === q[j], sau đó dp(i + 1, j + 1).
 */
export function segmentsOverlap(p: string, q: string): boolean {
  const n = p.length;
  const m = q.length;

  // Bảng nhớ trạng thái phẳng: -1 (chưa tính), 0 (false), 1 (true).
  // Vì độ dài segment hữu hạn, không gian trạng thái (n+1) * (m+1) là DAG hữu hạn, không bao giờ lặp vô tận.
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
      // Cả hai pattern đều đã duyệt hết -> tìm thấy chuỗi khớp chung.
      result = true;
    } else if (i < n && p.charAt(i) === '*') {
      // p[i] là '*':
      // 1) '*' khớp 0 ký tự -> nhảy qua: dp(i + 1, j)
      // 2) '*' khớp ít nhất 1 ký tự từ q -> q tiêu thụ 1 ký tự: j < m && dp(i, j + 1)
      if (dp(i + 1, j) || (j < m && dp(i, j + 1))) {
        result = true;
      }
    } else if (j < m && q.charAt(j) === '*') {
      // Đối xứng cho q[j] là '*':
      // 1) '*' khớp 0 ký tự -> nhảy qua: dp(i, j + 1)
      // 2) '*' khớp ít nhất 1 ký tự từ p -> p tiêu thụ 1 ký tự: i < n && dp(i + 1, j)
      if (dp(i, j + 1) || (i < n && dp(i + 1, j))) {
        result = true;
      }
    } else if (i < n && j < m) {
      // Cả hai bên đều là ký tự thường hoặc '?':
      // Khớp khi cả hai bằng nhau hoặc ít nhất một bên là '?'
      const pc = p.charAt(i);
      const qc = q.charAt(j);
      if (pc === '?' || qc === '?' || pc === qc) {
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
